// Read-only export, never generates data or runs migrations. Run from backend/ with node --import tsx.
import "../src/config/env.js";
import { readFile, writeFile } from "node:fs/promises";
import { createPool, transaction } from "../src/db/pool.js";
const args = process.argv.slice(2),
  org = args[args.indexOf("--org") + 1],
  out = args[args.indexOf("--out") + 1];
if (
  !args.includes("--org") ||
  !args.includes("--out") ||
  !/^[a-f0-9-]{36}$/i.test(org) ||
  !out
)
  throw new Error("--org UUID --out FILE required");
const db = createPool(
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
);
try {
  const sql = await readFile(
    new URL("../../ml/sql/export.sql", import.meta.url),
    "utf8",
  );
  const snapshot = await transaction(db, async (client) => {
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    await client.query("SET LOCAL statement_timeout='30s'");
    return (await client.query(sql, [org])).rows[0].snapshot;
  });
  await writeFile(out, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  console.log(
    JSON.stringify({
      source: snapshot.source,
      stations: snapshot.stations?.length,
      hours: snapshot.hours?.length,
      out,
    }),
  );
} finally {
  await db.end();
}
