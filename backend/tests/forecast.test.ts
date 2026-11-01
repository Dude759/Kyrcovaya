import { after, before, test } from "node:test";
import "../src/config/env.js";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { type Server } from "node:http";
import { loadConfig } from "../src/config/env.js";
import { createPool, type Database } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { seed, demoOrganizationId } from "../seeds/seed.js";
import { createApp } from "../src/app.js";
import { hashPassword, hashToken } from "../src/modules/auth/security.js";

// Deliberately no in-memory SQL substitute and no fallback to DATABASE_URL.
const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith("_test"))
  throw new Error(
    "TEST_DATABASE_URL must name a separate database ending in _test",
  );
const schema = `test_${randomBytes(10).toString("hex")}`;
const admin = createPool(connection);
let pool: Database;
let server: Server;
let base: string;
let driver: { token: string; user: { id: string } };
let operator: { token: string; user: { id: string } };
const demoPassword = "Integration12345";

async function request(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
  origin?: string,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // Heterogeneous HTTP responses are asserted below at runtime; pg is real in every case.
  const data: any = response.status === 204 ? null : await response.json();
  return { status: response.status, data, headers: response.headers };
}
async function login(email: string, role = "driver") {
  const value = await request("/api/auth/login", "POST", {
    email,
    password: demoPassword,
    role,
  });
  assert.equal(value.status, 200);
  return value.data;
}

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = createPool(connection, schema);
  await migrate(pool);
  await seed(pool, demoPassword, demoPassword);
  server = createApp(pool, {
    origins: ["http://localhost:5173"],
    AUTH_TTL_SECONDS: 3600,
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  driver = await login("driver@energotransport.test");
  operator = await login("operator@energotransport.test", "operator");
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
  // Only the randomly named schema created by THIS test run can be removed.
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

import { readFile } from "node:fs/promises";
import {
  readForecastBundle,
  verifyForecastBundle,
  seedForecast,
} from "../src/modules/operator/forecast.js";
import { randomUUID } from "node:crypto";
test("FCT00: 011 repeats, trusted Python offline forecast is seeded once with 24 immutable points", async () => {
  await migrate(pool);
  await seedForecast(pool);
  await seedForecast(pool);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM forecast_runs")).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM load_predictions")).rows[0]
      .n,
    24,
  );
  await assert.rejects(pool.query("UPDATE load_predictions SET power_kw=0"), {
    code: "23514",
  });
  await assert.rejects(pool.query("DELETE FROM forecast_runs"), {
    code: "23514",
  });
});
test("FCT01: working network stays NEEDS_MORE_DATA and demo source cannot masquerade as actual", async () => {
  const r = await request(
    "/api/operator/forecast",
    "GET",
    undefined,
    operator.token,
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.readiness, "NEEDS_MORE_DATA");
  assert.equal(r.data.forecast, null);
  assert.equal(r.data.source, "actual");
  const demo = await request(
    "/api/operator/forecast/demo",
    "GET",
    undefined,
    operator.token,
  );
  assert.equal(demo.status, 200);
  assert.equal(demo.data.forecast.source, "synthetic");
  assert.equal(demo.data.forecast.mode, "historical_replay");
  assert.equal(demo.data.forecast.origin, "2026-05-02T00:00:00Z");
  assert.equal(demo.data.forecast.points.length, 24);
  assert.equal(demo.data.staleForCurrentNetwork, true);
  const expected = await readForecastBundle();
  assert.deepEqual(demo.data.forecast, expected);
  for (let i = 0; i < 24; i++)
    assert.equal(
      Date.parse(expected.points[i].time),
      Date.parse(expected.origin) + (i + 1) * 3600000,
    );
});
test("FCT02: auth, role, strict inputs and organization isolation", async () => {
  assert.equal((await request("/api/operator/forecast/demo")).status, 401);
  assert.equal(
    (
      await request(
        "/api/operator/forecast/demo",
        "GET",
        undefined,
        driver.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/operator/forecast/demo?origin=now",
        "GET",
        undefined,
        operator.token,
      )
    ).status,
    400,
  );
  const org = randomUUID();
  await pool.query(
    "INSERT INTO organizations(id,name,network_limit_kw) VALUES($1,'Other ML org',100)",
    [org],
  );
  await pool.query(
    "INSERT INTO users(email_normalized,password_hash,name,role,organization_id) SELECT 'forecast.other@test.test',password_hash,'Other','operator',$1 FROM users WHERE id=$2",
    [org, operator.user.id],
  );
  const foreign = await login("forecast.other@test.test", "operator");
  assert.equal(
    (
      await request(
        "/api/operator/forecast/demo",
        "GET",
        undefined,
        foreign.token,
      )
    ).status,
    404,
  );
  assert.equal(
    (await request("/api/operator/forecast", "GET", undefined, foreign.token))
      .data.quality.stationHours,
    0,
  );
  assert.equal(
    (await request("/api/operator/forecast", "POST", {}, operator.token))
      .status,
    501,
  );
});
test("FCT03: model/data tampering refused before parsing, no untrusted pickle in Node", async () => {
  const raw = await readFile("assets/demo-forecast.json", "utf8");
  assert.throws(
    () => verifyForecastBundle(raw.replace("synthetic", "actual")),
    /checksum/,
  );
  assert.throws(
    () => verifyForecastBundle(raw.replace("rf-synthetic-v1", "wrong-model")),
    /checksum/,
  );
  const r = await readForecastBundle();
  r.datasetHash = "bad";
  assert.throws(() => verifyForecastBundle(JSON.stringify(r)), /checksum/);
});
test("FCT04: API replay after actual Node restart and new login preserves dates and results", async () => {
  const url = new URL(connection!);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "0",
      DATABASE_URL: url.toString(),
      DATABASE_URL_UNPOOLED: url.toString(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const address = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Process startup timeout")),
        15000,
      );
      child.stdout!.on("data", (c) => {
        const m = String(c).match(
          /API listening on (http:\/\/127\.0\.0\.1:\d+)/,
        );
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
    });
    const r = await fetch(address + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "operator@energotransport.test",
        password: demoPassword,
        role: "operator",
      }),
    });
    const auth = (await r.json()) as any;
    assert.equal(r.status, 200);
    const replay = await fetch(address + "/api/operator/forecast/demo", {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(
      ((await replay.json()) as any).forecast,
      await readForecastBundle(),
    );
  } finally {
    child.kill();
  }
});
test("FCT05: informational reads do not affect dispatch, sessions, payments, settlements or measurements", async () => {
  const tables = [
    "charging_sessions",
    "payments",
    "session_measurements",
    "session_settlements",
    "grid_states",
    "power_commands",
    "session_power_history",
  ];
  const snapshot = async () =>
    Promise.all(
      tables.map(
        async (t) =>
          (
            await pool.query(
              `SELECT COALESCE(jsonb_agg(to_jsonb(x)),'[]') data FROM ${t} x`,
            )
          ).rows[0].data,
      ),
    );
  const before = await snapshot();
  for (let i = 0; i < 3; i++) {
    await request("/api/operator/forecast", "GET", undefined, operator.token);
    await request(
      "/api/operator/forecast/demo",
      "GET",
      undefined,
      operator.token,
    );
  }
  assert.deepEqual(await snapshot(), before);
});
