import { loadConfig } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { createApp } from "./app.js";
import { recoverPayments } from "./modules/payments/service.js";
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
    .catch(() =>
      console.error("Payment recovery failed; durable work will be retried"),
    )
    .finally(() => {
      recovering = undefined;
    });
}
recover();
const recoveryTimer = setInterval(recover, 15000).unref();
function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(recoveryTimer);
  const timer = setTimeout(() => process.exit(1), 10000).unref();
  server.close(async () => {
    await recovering;
    await pool.end();
    clearTimeout(timer);
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
