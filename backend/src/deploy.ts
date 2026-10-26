import { loadConfig } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { seed } from "../seeds/seed.js";

// Free web services have no pre-deploy command; bootstrap must succeed before listening.
const config = loadConfig();
const pool = createPool(config.DATABASE_URL_UNPOOLED ?? config.DATABASE_URL);
try {
  await migrate(pool);
  console.log("Migrations ready");
  if (config.DEPLOY_SEED === "true") {
    const operatorPassword = process.env.SEED_OPERATOR_PASSWORD;
    const driverPassword = process.env.SEED_DRIVER_PASSWORD;
    if (!operatorPassword || !driverPassword)
      throw new Error("Set both seed password variables");
    await seed(pool, operatorPassword, driverPassword);
    console.log("Demonstration seed ready; existing records preserved");
  }
} catch {
  console.error(
    "Release bootstrap failed; check migration history and server environment",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
if (!process.exitCode) await import("./server.js");
