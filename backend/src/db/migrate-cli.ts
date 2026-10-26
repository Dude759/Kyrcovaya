import { loadConfig } from "../config/env.js";
import { createPool } from "./pool.js";
import { migrate } from "./migrate.js";
const pool = createPool(loadConfig().DATABASE_URL);
try {
  await migrate(pool);
  console.log("Migrations applied");
} finally {
  await pool.end();
}
