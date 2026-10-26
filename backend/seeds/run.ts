import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { seed } from "./seed.js";
const pool = createPool(loadConfig().DATABASE_URL);
try {
  if (!process.env.SEED_OPERATOR_PASSWORD || !process.env.SEED_DRIVER_PASSWORD)
    throw new Error("Set both SEED_*_PASSWORD variables");
  await seed(
    pool,
    process.env.SEED_OPERATOR_PASSWORD,
    process.env.SEED_DRIVER_PASSWORD,
  );
  console.log(
    "Seed complete: 1 organization, 1 operator, 2 drivers, 8 stations; existing records preserved",
  );
} finally {
  await pool.end();
}
