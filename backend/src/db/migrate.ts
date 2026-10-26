import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { transaction, type Database } from "./pool.js";

// Files are deliberately outside dist; run from the backend project directory.
export async function migrate(pool: Database) {
  const files = (await readdir("migrations"))
    .filter((f) => /^\d+_[a-z_]+\.sql$/.test(f))
    .sort();
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(7241031)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of files) {
      // Git checkouts may use CRLF on Windows and LF in CI; schema history must agree.
      const sql = (await readFile(`migrations/${name}`, "utf8")).replaceAll(
        "\r\n",
        "\n",
      );
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = await client.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (previous.rows.length) {
        if (previous.rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(name, checksum) VALUES ($1,$2)",
        [name, checksum],
      );
    }
  });
}
