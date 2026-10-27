import { loadConfig } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { createApp } from "./app.js";
import { recoverPayments } from "./modules/payments/service.js";
import { SimulatorChargerAdapter } from "./modules/sessions/adapter.js";
import { runChargingCycle } from "./modules/sessions/service.js";
import { recoverBookingLifecycle } from "./modules/bookings/service.js";
const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
try {
  await pool.query("SELECT 1");
} catch {
  await pool.end();
  throw new Error("Database is unavailable; check environment and PostgreSQL");
}
const server = createApp(pool, config).listen(config.PORT, config.HOST, () => {
  const address = server.address();
  console.log(
    `API listening on http://${config.HOST}:${typeof address === "object" ? address?.port : config.PORT}`,
  );
});
let stopping = false;
let recovering: Promise<void> | undefined;
function recover() {
  if (stopping || recovering) return;
  recovering = recoverPayments(pool)
    .then(() => recoverBookingLifecycle(pool))
    .catch(() =>
      console.error("Payment recovery failed; durable work will be retried"),
    )
    .finally(() => {
      recovering = undefined;
    });
}
recover();
const recoveryTimer = setInterval(recover, 15000).unref();
const charger = new SimulatorChargerAdapter(pool);
let charging: Promise<void> | undefined;
function charge() {
  if (stopping || charging) return;
  charging = runChargingCycle(pool, charger)
    .catch(() =>
      console.error(
        "Charging recovery failed; durable commands will be retried",
      ),
    )
    .finally(() => {
      charging = undefined;
    });
}
charge();
const chargingTimer = setInterval(charge, 1000).unref();
function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(recoveryTimer);
  clearInterval(chargingTimer);
  const timer = setTimeout(() => process.exit(1), 10000).unref();
  server.close(async () => {
    await recovering;
    await charging;
    await pool.end();
    clearTimeout(timer);
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
