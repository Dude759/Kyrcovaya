import { after, before, test } from "node:test";
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

test("B01: clean migrations, foundation and reservation tables, repeatable seed preserves edits", async () => {
  await migrate(pool);
  const { rows } = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
    [schema],
  );
  assert.deepEqual(
    rows.map((r) => r.tablename),
    [
      "auth_sessions",
      "booking_closures",
      "booking_refunds",
      "bookings",
      "charging_command_requests",
      "charging_commands",
      "charging_sessions",
      "connector_reservations",
      "connectors",
      "driver_profiles",
      "network_events",
      "operator_requests",
      "organizations",
      "payment_attempts",
      "payment_compensations",
      "payment_events",
      "payments",
      "power_measurements",
      "schema_migrations",
      "session_measurements",
      "session_refunds",
      "session_settlements",
      "simulator_command_receipts",
      "simulator_devices",
      "simulator_session_state",
      "stations",
      "test_booking_refund_receipts",
      "test_refund_receipts",
      "test_session_refund_receipts",
      "user_preferences",
      "users",
    ],
  );
  await pool.query(
    "UPDATE stations SET name='Сохранённое имя' WHERE id='tverskaya-plaza'",
  );
  await seed(pool, demoPassword, demoPassword);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM stations")).rows[0].n,
    8,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM connectors")).rows[0].n,
    44,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n,
    3,
  );
  assert.equal(
    (await pool.query("SELECT name FROM stations WHERE id='tverskaya-plaza'"))
      .rows[0].name,
    "Сохранённое имя",
  );
});

const profile = {
  name: "Тестовый Водитель",
  email: "New.Driver@Example.test",
  phone: "+7 900 123-45-67",
  vehicle: "Test EV",
  plate: "",
  connector: "CCS2",
  battery: 65,
};
test("B02: registration is persisted; scrypt and token hash only", async () => {
  const result = await request("/api/auth/register", "POST", {
    ...profile,
    password: demoPassword,
  });
  assert.equal(result.status, 201);
  assert.equal(result.data.user.role, "driver");
  assert.equal(result.data.user.email, "new.driver@example.test");
  assert.equal(result.data.user.battery, 65);
  const stored = (
    await pool.query("SELECT password_hash FROM users WHERE id=$1", [
      result.data.user.id,
    ])
  ).rows[0];
  assert.match(stored.password_hash, /^scrypt\$131072\$8\$1\$/);
  assert(!stored.password_hash.includes(demoPassword));
  const sessions = (
    await pool.query("SELECT token_hash FROM auth_sessions WHERE user_id=$1", [
      result.data.user.id,
    ])
  ).rows;
  assert.equal(sessions[0].token_hash, hashToken(result.data.token));
  assert.notEqual(sessions[0].token_hash, result.data.token);
  assert.equal(
    (await request("/api/auth/me", "GET", undefined, result.data.token)).data
      .user,
    undefined,
  );
  assert.equal(
    (await request("/api/auth/me", "GET", undefined, result.data.token)).data
      .id,
    result.data.user.id,
  );
});

test("B03: duplicate/case email, operator/organization escalation and malformed profile rejected", async () => {
  assert.equal(
    (
      await request("/api/auth/register", "POST", {
        ...profile,
        email: profile.email.toUpperCase(),
        password: demoPassword,
      })
    ).status,
    409,
  );
  for (const extra of [
    { role: "operator" },
    { organizationId: demoOrganizationId },
    { battery: 1 },
    { connector: "unsafe" },
    { password: "short" },
  ]) {
    assert.equal(
      (
        await request("/api/auth/register", "POST", {
          ...profile,
          email: "invalid@example.test",
          password: demoPassword,
          ...extra,
        })
      ).status,
      400,
    );
  }
  const reply = await fetch(base + "/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{bad",
  });
  assert.equal(reply.status, 400);
});

test("B04: wrong password/role, disabled user, expiry and revocation never authenticate", async () => {
  assert.equal(
    (
      await request("/api/auth/login", "POST", {
        email: "driver@energotransport.test",
        password: "incorrect",
        role: "driver",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/login", "POST", {
        email: "absent@energotransport.test",
        password: demoPassword,
        role: "driver",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/login", "POST", {
        email: "driver@energotransport.test",
        password: demoPassword,
        role: "operator",
      })
    ).status,
    401,
  );
  assert.equal((await request("/api/workspace")).status, 401);
  const temporary = await login("driver2@energotransport.test");
  assert.equal(
    (await request("/api/auth/logout", "POST", undefined, temporary.token))
      .status,
    204,
  );
  assert.equal(
    (await request("/api/auth/me", "GET", undefined, temporary.token)).status,
    401,
  );
  assert(
    (
      await pool.query(
        "SELECT revoked_at FROM auth_sessions WHERE token_hash=$1",
        [hashToken(temporary.token)],
      )
    ).rows[0].revoked_at,
  );
  const expired = await login("driver2@energotransport.test");
  await pool.query(
    "UPDATE auth_sessions SET created_at=now()-interval '2 days',expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [hashToken(expired.token)],
  );
  assert.equal(
    (await request("/api/auth/me", "GET", undefined, expired.token)).status,
    401,
  );
  await pool.query("UPDATE users SET disabled_at=now() WHERE id=$1", [
    expired.user.id,
  ]);
  assert.equal(
    (
      await request("/api/auth/login", "POST", {
        email: "driver2@energotransport.test",
        password: demoPassword,
        role: "driver",
      })
    ).status,
    401,
  );
  await pool.query("UPDATE users SET disabled_at=NULL WHERE id=$1", [
    expired.user.id,
  ]);
});

test("B05: organizations isolated in workspace, catalog, detail and port routes", async () => {
  const org = (
    await pool.query(
      "INSERT INTO organizations(name,network_limit_kw) VALUES ('Другая организация',100) RETURNING id",
    )
  ).rows[0].id;
  const user = (
    await pool.query(
      "INSERT INTO users(email_normalized,password_hash,name,role,organization_id) VALUES ('other.operator@example.test',$1,'Другой оператор','operator',$2) RETURNING id",
      [await hashPassword(demoPassword), org],
    )
  ).rows[0].id;
  await pool.query("INSERT INTO user_preferences(user_id) VALUES ($1)", [user]);
  await pool.query(
    "INSERT INTO stations(id,organization_id,name,address,district,longitude,latitude,max_power_kw,limit_kw,price_per_kwh_kopecks,operating_state) VALUES ('other-station',$1,'Чужая станция','Другой адрес','Район',37.5,55.7,100,100,1800,'online')",
    [org],
  );
  await pool.query(
    "INSERT INTO connectors(station_id,label,type,max_power_kw,operating_state) VALUES ('other-station','1','CCS2',100,'idle')",
  );
  const other = await login("other.operator@example.test", "operator");
  assert(!("battery" in other.user));
  const workspace = await request(
    "/api/workspace",
    "GET",
    undefined,
    other.token,
  );
  assert.deepEqual(
    workspace.data.stations.map((s: { id: string }) => s.id),
    ["other-station"],
  );
  assert.equal(workspace.data.organization, "Другая организация");
  const own = await request("/api/workspace", "GET", undefined, operator.token);
  assert(
    !own.data.stations.some((s: { id: string }) => s.id === "other-station"),
  );
  assert.equal(
    (
      await request(
        "/api/stations/other-station",
        "GET",
        undefined,
        operator.token,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        "/api/stations/other-station/connectors",
        "GET",
        undefined,
        operator.token,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        "/api/stations?organizationId=" + org,
        "GET",
        undefined,
        operator.token,
      )
    ).status,
    400,
  );
  const all = await request("/api/stations", "GET", undefined, driver.token);
  assert(all.data.items.some((s: { id: string }) => s.id === "other-station"));
  assert.equal(
    (
      await request(
        "/api/operator/network",
        "PATCH",
        { networkLimit: 99 },
        driver.token,
      )
    ).status,
    403,
  );
});

async function startProcess() {
  const url = new URL(connection!);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "0",
      DATABASE_URL: url.toString(),
    },
  });
  const address = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Child server did not start"));
    }, 15000);
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("Child server exited before listening"));
    });
    child.stdout!.on("data", (chunk) => {
      const match = /API listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(
        String(chunk),
      );
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });
  return { child, address };
}
async function stopProcess(child: ChildProcess) {
  const stopped = once(child, "exit");
  child.kill();
  await stopped;
}

test("B06: profile/preferences and existing token survive a real OS process restart", async () => {
  const saved = await request(
    "/api/profile",
    "PATCH",
    {
      ...profile,
      email: "driver@energotransport.test",
      name: "После перезапуска",
      battery: 82,
    },
    driver.token,
  );
  assert.equal(saved.status, 200);
  assert.equal(
    (
      await request(
        "/api/preferences",
        "PATCH",
        { receipts: false },
        driver.token,
      )
    ).status,
    200,
  );
  const originalBase = base;
  const first = await startProcess();
  try {
    base = first.address;
    assert.equal(
      (await request("/api/auth/me", "GET", undefined, driver.token)).data.name,
      "После перезапуска",
    );
  } finally {
    base = originalBase;
    await stopProcess(first.child);
  }
  const second = await startProcess();
  try {
    base = second.address;
    const me = await request("/api/auth/me", "GET", undefined, driver.token);
    assert.equal(me.status, 200);
    assert.equal(me.data.battery, 82);
    assert.equal(
      (await request("/api/workspace", "GET", undefined, driver.token)).data
        .preferences.receipts,
      false,
    );
  } finally {
    base = originalBase;
    await stopProcess(second.child);
  }
});

test("B07: database constraints, API validation and physical port aggregation", async () => {
  for (const [column, value] of [
    ["longitude", 181],
    ["latitude", 91],
    ["limit_kw", 1000001],
    ["max_power_kw", -1],
    ["price_per_kwh_kopecks", -10],
  ]) {
    // Identifiers are fixed test literals; no user-supplied SQL identifiers.
    await assert.rejects(
      pool.query(
        `UPDATE stations SET ${column}=$1 WHERE id='tverskaya-plaza'`,
        [value],
      ),
      (e: { code?: string }) => e.code === "23514",
    );
  }
  await assert.rejects(
    pool.query(
      "UPDATE connectors SET max_power_kw=-1 WHERE station_id='tverskaya-plaza'",
    ),
    (e: { code?: string }) => e.code === "23514",
  );
  assert.equal((await request("/api/stations?minPowerKw=-1")).status, 400);
  assert.equal((await request("/api/stations?limit=0")).status, 400);
  assert.equal(
    (
      await request(
        "/api/profile",
        "PATCH",
        { ...profile, battery: 500 },
        driver.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/preferences",
        "PATCH",
        { receipts: "yes" },
        driver.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/profile",
        "PATCH",
        { ...profile, role: "operator" },
        driver.token,
      )
    ).status,
    400,
  );
  const station = (
    await request(
      "/api/stations/tverskaya-plaza",
      "GET",
      undefined,
      driver.token,
    )
  ).data;
  const ports = (
    await request(
      "/api/stations/tverskaya-plaza/connectors",
      "GET",
      undefined,
      driver.token,
    )
  ).data;
  assert.equal(
    station.connectors.find((c: { type: string }) => c.type === "CCS2").total,
    4,
  );
  assert.equal(ports.length, 8);
  assert.equal(new Set(ports.map((c: { id: string }) => c.id)).size, 8);
  assert.equal(station.loadPercent, null);
  const filtered = await request(
    "/api/stations?connector=CHAdeMO&minPowerKw=100&availableOnly=true",
  );
  assert(filtered.data.items.length > 0);
  assert(
    filtered.data.items.every(
      (s: {
        connectors: { type: string; powerKw: number; available: number }[];
      }) =>
        s.connectors.some(
          (c) => c.type === "CHAdeMO" && c.powerKw >= 100 && c.available > 0,
        ),
    ),
  );
  const page = await request("/api/stations?limit=1");
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.nextCursor, page.data.items[0].id);
});

test("B08: two independent authenticated clients see the same PostgreSQL catalog update", async () => {
  const second = await login("driver2@energotransport.test");
  await pool.query(
    "UPDATE stations SET longitude=37.6123456,name='Обновление из PostgreSQL' WHERE id='tverskaya-plaza'",
  );
  const [a, b] = await Promise.all([
    request("/api/stations/tverskaya-plaza", "GET", undefined, driver.token),
    request("/api/stations/tverskaya-plaza", "GET", undefined, second.token),
  ]);
  assert.deepEqual(a.data, b.data);
  assert.equal(a.data.coordinates[0], 37.6123456);
  assert.equal(a.data.name, "Обновление из PostgreSQL");
});

test("B09/B10: workspace is honest; unsupported server workflows never succeed", async () => {
  const data = (await request("/api/workspace", "GET", undefined, driver.token))
    .data;
  for (const key of ["bookings", "sessions", "payments", "events"])
    assert.deepEqual(data[key], []);
  assert.equal(data.forecast, null);
  assert.equal(data.stage, "bookings");
  for (const path of ["/api/bookings", "/api/auth/password"])
    assert.equal((await request(path, "POST", {}, driver.token)).status, 501);
  assert.equal(
    (await request("/api/payments", "POST", {}, driver.token)).status,
    400,
  );
  assert.equal(
    (await request("/api/operator/forecast", "POST", {}, operator.token))
      .status,
    501,
  );
  assert.equal(
    (await request("/api/auth/recovery", "POST", { email: profile.email }))
      .status,
    501,
  );
  assert.equal(
    (await request("/api/demo/payments/test", "POST", {}, driver.token)).status,
    404,
  );
});

test("HTTP boundaries: health/readiness, exact CORS origin, no cache or implementation headers", async () => {
  assert.equal((await request("/health")).data.status, "ok");
  assert.equal((await request("/ready")).data.status, "ready");
  const allowed = await request(
    "/api/stations",
    "GET",
    undefined,
    undefined,
    "http://localhost:5173",
  );
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    "http://localhost:5173",
  );
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.equal(allowed.headers.get("x-powered-by"), null);
  assert.equal(
    (
      await request(
        "/api/stations",
        "GET",
        undefined,
        undefined,
        "https://untrusted.example",
      )
    ).status,
    403,
  );
});

test("Public demo: shared login identity cannot be overwritten; own profile remains persistent", async () => {
  const demoServer = createApp(pool, {
    origins: ["http://localhost:5173"],
    AUTH_TTL_SECONDS: 3600,
    PUBLIC_DEMO: "true",
    TRUST_PROXY_HOPS: 1,
  }).listen(0, "127.0.0.1");
  await once(demoServer, "listening");
  const address = demoServer.address();
  assert(address && typeof address === "object");
  const previous = base;
  base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(
      (
        await request(
          "/api/profile",
          "PATCH",
          { ...profile, email: "stolen@example.test" },
          driver.token,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/profile",
          "PATCH",
          { ...profile, email: "driver@energotransport.test" },
          driver.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request("/api/auth/me", "GET", undefined, driver.token)).data
        .email,
      "driver@energotransport.test",
    );
  } finally {
    base = previous;
    demoServer.closeAllConnections();
    await new Promise<void>((resolve) => demoServer.close(() => resolve()));
  }
});

test("Production configuration requires explicit origins and certificate-verified remote database", () => {
  const keys = [
    "NODE_ENV",
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "CORS_ORIGINS",
  ] as const;
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  try {
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL_UNPOOLED;
    process.env.DATABASE_URL =
      "postgresql://fixture:fixture@db.example.test/fixture?sslmode=require";
    process.env.CORS_ORIGINS = "https://dude759.github.io";
    assert.throws(() => loadConfig(), /verify-full/);
    process.env.DATABASE_URL =
      "postgresql://fixture:fixture@db.example.test/fixture?sslmode=verify-full";
    assert.deepEqual(loadConfig().origins, ["https://dude759.github.io"]);
    delete process.env.CORS_ORIGINS;
    assert.throws(() => loadConfig(), /explicit/);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
