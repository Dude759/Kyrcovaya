import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { seed } from "../seeds/seed.js";

test("ML export CLI reads isolated PostgreSQL without changing catalog or generating telemetry", async () => {
  const connection = process.env.TEST_DATABASE_URL;
  assert(connection && new URL(connection).pathname.endsWith("_test"));
  const schema = "test_" + randomBytes(10).toString("hex"),
    admin = createPool(connection);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = createPool(connection, schema);
  const dir = await mkdtemp(join(tmpdir(), "energotransport-ml-export-")),
    file = join(dir, "snapshot.json");
  try {
    await migrate(pool);
    await seed(pool, "ExportFixture12345", "ExportFixture12345");
    const before = (
      await pool.query(
        "SELECT jsonb_agg(to_jsonb(s) ORDER BY id) AS data FROM stations s",
      )
    ).rows[0].data;
    const url = new URL(connection);
    url.searchParams.set("options", `-c search_path=${schema},public`);
    await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/export-ml-snapshot.mjs",
        "--org",
        "00000000-0000-4000-8000-000000000001",
        "--out",
        file,
      ],
      {
        windowsHide: true,
        env: {
          ...process.env,
          DATABASE_URL: url.toString(),
          DATABASE_URL_UNPOOLED: url.toString(),
        },
      },
    );
    const snapshot = JSON.parse(await readFile(file, "utf8"));
    assert.equal(snapshot.source, "server_simulator");
    assert.equal(snapshot.stations.length, 8);
    assert.equal(snapshot.hours, null);
    assert.equal(snapshot.grid, null);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT jsonb_agg(to_jsonb(s) ORDER BY id) AS data FROM stations s",
        )
      ).rows[0].data,
      before,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM power_measurements"))
        .rows[0].n,
      0,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM session_measurements"))
        .rows[0].n,
      0,
    );
  } finally {
    await unlink(file).catch(() => {});
    await rmdir(dir);
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
