import { runGridCycle } from "./modules/operator/grid.js";
import { loadConfig } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { createApp } from "./app.js";
import { recoverPayments } from "./modules/payments/service.js";
import { SimulatorChargerAdapter } from "./modules/sessions/adapter.js";
import { runChargingCycle } from "./modules/sessions/service.js";
import { recoverBookingLifecycle } from "./modules/bookings/service.js";
import { buildPowerHistory } from "./modules/operator/aggregation.js";
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
  charging = runChargingCycle(
    pool,
    charger,
    undefined,
    config.GRID_FRESHNESS_SECONDS,
  )
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
let aggregating: Promise<unknown> | undefined;
function aggregate() {
  if (stopping || aggregating) return;
  aggregating = buildPowerHistory(pool)
    .catch(() =>
      console.error(
        "Simulator history aggregation failed; durable raw readings will be retried",
      ),
    )
    .finally(() => {
      aggregating = undefined;
    });
}
aggregate();
const historyTimer = setInterval(aggregate, 60000).unref();
let gridWork: Promise<unknown> | undefined;
function grid() {
  if (stopping || gridWork) return;
  gridWork = runGridCycle(pool, config.GRID_FRESHNESS_SECONDS)
    .catch(() => console.error("Grid planning will be retried"))
    .finally(() => {
      gridWork = undefined;
    });
}
grid();
const gridTimer = setInterval(grid, 15000).unref();
function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(recoveryTimer);
  clearInterval(chargingTimer);
  clearInterval(historyTimer);
  clearInterval(gridTimer);
  const timer = setTimeout(() => process.exit(1), 10000).unref();
  server.close(async () => {
    await recovering;
    await charging;
    await aggregating;
    await gridWork;
    await pool.end();
    clearTimeout(timer);
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
