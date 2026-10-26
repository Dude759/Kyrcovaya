import { loadConfig } from "../config/env.js";
import { createPool } from "./pool.js";
import { migrate } from "./migrate.js";
const config = loadConfig();
const pool = createPool(config.DATABASE_URL_UNPOOLED ?? config.DATABASE_URL);
try {
  await migrate(pool);
  console.log("Migrations applied");
} finally {
  await pool.end();
}
