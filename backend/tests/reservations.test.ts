import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import "../src/config/env.js";
import { createPool, type Database } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { seed, demoOrganizationId } from "../seeds/seed.js";
import { createApp } from "../src/app.js";
import {
  createHold,
  releaseHold,
} from "../src/modules/reservations/service.js";

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith("_test"))
  throw new Error("Separate TEST_DATABASE_URL ending in _test is required");
const schema = `test_${randomBytes(10).toString("hex")}`;
const admin = createPool(connection);
let pool: Database,
  server: Server,
  base: string,
  driverToken: string,
  operatorToken: string;
let first: string,
  second: string,
  otherStationPort: string,
  foreignPort: string;
const foreignOrg = randomUUID();
const password = "ReservationTests12345";
function interval(offsetMinutes = 0) {
  const start = Date.now() + 86400000 + offsetMinutes * 60000;
  return {
    startAt: new Date(start).toISOString(),
    endAt: new Date(start + 3600000).toISOString(),
  };
}
function input(connectorId = first, times = interval()) {
  return {
    organizationId: demoOrganizationId,
    stationId: "tverskaya-plaza",
    connector: "CCS2",
    connectorId,
    ...times,
  };
}
async function insert(
  connectorId: string,
  times = interval(),
  state = "held",
  expiresAt?: Date,
) {
  return (
    await pool.query(
      `INSERT INTO connector_reservations(connector_id,start_at,end_at,state,expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        connectorId,
        times.startAt,
        times.endAt,
        state,
        expiresAt ?? (state === "held" ? new Date(Date.now() + 600000) : null),
      ],
    )
  ).rows[0];
}
const isStatus = (status: number) => (error: unknown) =>
  (error as { status?: number }).status === status;
const isCode = (code: string) => (error: unknown) =>
  (error as { code?: string }).code === code;
async function request(
  path: string,
  token?: string,
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data: any = await response.json();
  return { status: response.status, data };
}
function query(start = interval().startAt) {
  return new URLSearchParams({
    start,
    duration: "60",
    connector: "CCS2",
  }).toString();
}

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = createPool(connection, schema);
  await migrate(pool);
  await migrate(pool);
  await seed(pool, password, password);
  const ports = (
    await pool.query(
      "SELECT id FROM connectors WHERE station_id='tverskaya-plaza' AND type='CCS2' ORDER BY id",
    )
  ).rows;
  assert(ports.length >= 2);
  first = ports[0].id;
  second = ports[1].id;
  otherStationPort = (
    await pool.query(
      "SELECT id FROM connectors WHERE station_id='city-hub' AND type='CCS2' ORDER BY id LIMIT 1",
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO organizations(id,name,network_limit_kw) VALUES ($1,'Reservation isolation',200)",
    [foreignOrg],
  );
  await pool.query(
    `INSERT INTO stations(id,organization_id,name,address,district,longitude,latitude,max_power_kw,limit_kw,price_per_kwh_kopecks,operating_state)
    VALUES ('foreign-reservation-station',$1,'Чужая станция','Тестовый адрес','Район',37,55,100,100,1800,'online')`,
    [foreignOrg],
  );
  foreignPort = (
    await pool.query(
      "INSERT INTO connectors(station_id,label,type,max_power_kw,operating_state) VALUES ('foreign-reservation-station','1','CCS2',100,'idle') RETURNING id",
    )
  ).rows[0].id;
  server = createApp(pool, {
    origins: ["http://localhost:5173"],
    AUTH_TTL_SECONDS: 3600,
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  driverToken = (
    await request("/api/auth/login", undefined, "POST", {
      email: "driver@energotransport.test",
      password,
      role: "driver",
    })
  ).data.token;
  operatorToken = (
    await request("/api/auth/login", undefined, "POST", {
      email: "operator@energotransport.test",
      password,
      role: "operator",
    })
  ).data.token;
  assert(driverToken && operatorToken);
});
beforeEach(async () => {
  // Only this run's random isolated schema, never the application/public database.
  await pool.query("DELETE FROM connector_reservations");
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (pool) await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test("R00: migration installs btree_gist, timestamptz and exclusion predicate", async () => {
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM pg_extension WHERE extname='btree_gist'",
      )
    ).rows[0].n,
    1,
  );
  const columns = (
    await pool.query(
      "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='connector_reservations'",
      [schema],
    )
  ).rows;
  for (const name of ["start_at", "end_at", "expires_at"])
    assert.equal(
      columns.find((c) => c.column_name === name)?.data_type,
      "timestamp with time zone",
    );
  const constraint = (
    await pool.query(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='connector_reservations'::regclass AND conname='reservation_no_overlap'",
    )
  ).rows[0].def;
  assert.match(constraint, /EXCLUDE USING gist/);
  assert.match(constraint, /held/);
  assert.match(constraint, /confirmed/);
  assert(!constraint.includes("now()"));
});
test("R01: free interval creates an internal hold with bounded expiry", async () => {
  const held = await createHold(pool, input());
  assert.equal(held.connectorId, first);
  assert.equal(held.state, "held");
  assert(Date.parse(held.expiresAt!) <= Date.parse(held.startAt));
  assert(Date.parse(held.expiresAt!) - Date.parse(held.createdAt) <= 900000);
  const near = new Date(Date.now() + 60000).toISOString();
  const short = await createHold(
    pool,
    input(second, {
      startAt: near,
      endAt: new Date(Date.parse(near) + 1800000).toISOString(),
    }),
  );
  assert.equal(short.expiresAt, near);
});
test("R02: identical intervals on one physical port conflict at the DB boundary", async () => {
  const times = interval();
  await insert(first, times);
  await assert.rejects(insert(first, times), isCode("23P01"));
});
test("R03: partial overlaps and held versus confirmed conflict", async () => {
  const times = interval();
  await insert(first, times, "confirmed");
  await assert.rejects(
    insert(first, {
      startAt: new Date(Date.parse(times.startAt) + 1800000).toISOString(),
      endAt: new Date(Date.parse(times.endAt) + 1800000).toISOString(),
    }),
    isCode("23P01"),
  );
});
test("R04: adjacent half-open intervals are allowed, including equivalent offsets", async () => {
  const times = interval();
  await createHold(pool, input(first, times));
  const start = new Date(Date.parse(times.endAt) + 3 * 3600000)
    .toISOString()
    .replace("Z", "+03:00");
  await createHold(
    pool,
    input(first, {
      startAt: start,
      endAt: new Date(Date.parse(times.endAt) + 3600000).toISOString(),
    }),
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM connector_reservations"))
      .rows[0].n,
    2,
  );
});
test("R05: separate physical ports of one station can overlap", async () => {
  const times = interval();
  await createHold(pool, input(first, times));
  await createHold(pool, input(second, times));
});
test("R06: separate stations can overlap", async () => {
  const times = interval();
  await createHold(pool, input(first, times));
  await createHold(pool, {
    ...input(otherStationPort, times),
    stationId: "city-hub",
  });
});
test("R07: releasing a hold frees the interval; release is idempotent and scoped", async () => {
  const times = interval(),
    held = await createHold(pool, input(first, times));
  await assert.rejects(releaseHold(pool, foreignOrg, held.id), isStatus(404));
  assert.equal(
    (await releaseHold(pool, demoOrganizationId, held.id)).state,
    "released",
  );
  assert.equal(
    (await releaseHold(pool, demoOrganizationId, held.id)).state,
    "released",
  );
  await createHold(pool, input(first, times));
  const confirmed = await insert(second, times, "confirmed");
  await assert.rejects(
    releaseHold(pool, demoOrganizationId, confirmed.id),
    isStatus(409),
  );
});
test("R08: expired rows no longer block the same interval", async () => {
  const times = interval();
  await insert(first, times, "expired");
  await createHold(pool, input(first, times));
});
test("R09: elapsed held is explicitly expired before a new hold is selected", async () => {
  const times = interval();
  const old = (
    await pool.query(
      `INSERT INTO connector_reservations(connector_id,start_at,end_at,expires_at,created_at)
    VALUES ($1,$2,$3,clock_timestamp()-interval '1 minute',clock_timestamp()-interval '2 minutes') RETURNING id`,
      [first, times.startAt, times.endAt],
    )
  ).rows[0].id;
  await createHold(pool, input(first, times));
  assert.equal(
    (
      await pool.query("SELECT state FROM connector_reservations WHERE id=$1", [
        old,
      ])
    ).rows[0].state,
    "expired",
  );
});
test("R10: missing, foreign, mismatched, archived and unavailable ports/stations are rejected", async () => {
  await assert.rejects(createHold(pool, input(randomUUID())), isStatus(404));
  await assert.rejects(
    createHold(pool, { ...input(), organizationId: foreignOrg }),
    isStatus(404),
  );
  await assert.rejects(createHold(pool, input(foreignPort)), isStatus(404));
  await assert.rejects(
    createHold(pool, input(otherStationPort)),
    isStatus(404),
  );
  await assert.rejects(insert(randomUUID()), isCode("23503"));
  for (const state of ["service", "offline"]) {
    await pool.query("UPDATE connectors SET operating_state=$1 WHERE id=$2", [
      state,
      first,
    ]);
    await assert.rejects(createHold(pool, input()), isStatus(409));
  }
  await pool.query(
    "UPDATE connectors SET operating_state='idle', archived_at=now() WHERE id=$1",
    [first],
  );
  await assert.rejects(createHold(pool, input()), isStatus(404));
  await pool.query("UPDATE connectors SET archived_at=NULL WHERE id=$1", [
    first,
  ]);
  for (const state of ["service", "offline"]) {
    await pool.query(
      "UPDATE stations SET operating_state=$1 WHERE id='tverskaya-plaza'",
      [state],
    );
    await assert.rejects(createHold(pool, input()), isStatus(409));
  }
  await pool.query(
    "UPDATE stations SET operating_state='online',archived_at=now() WHERE id='tverskaya-plaza'",
  );
  await assert.rejects(createHold(pool, input()), isStatus(404));
  await pool.query(
    "UPDATE stations SET archived_at=NULL WHERE id='tverskaya-plaza'",
  );
});
test("R11: invalid ranges, nonfinite timestamps and held without expiry are rejected by PostgreSQL", async () => {
  const times = interval();
  for (const endAt of [
    times.startAt,
    new Date(Date.parse(times.startAt) - 1).toISOString(),
  ])
    await assert.rejects(insert(first, { ...times, endAt }), (e) =>
      ["23514", "22000"].includes((e as { code: string }).code),
    );
  await assert.rejects(
    insert(first, { startAt: times.startAt, endAt: "infinity" }, "confirmed"),
    isCode("23514"),
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO connector_reservations(connector_id,start_at,end_at) VALUES ($1,$2,$3)",
      [first, times.startAt, times.endAt],
    ),
    isCode("23514"),
  );
});
test("R12: two real PostgreSQL transactions overlap; second waits and loses at exclusion constraint", async () => {
  const a = await pool.connect(),
    b = await pool.connect();
  let secondInsert: Promise<unknown> | undefined;
  try {
    await a.query("BEGIN");
    await b.query("BEGIN");
    const pidA = (await a.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const pidB = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    assert.notEqual(pidA, pidB);
    const times = interval();
    const sql =
      "INSERT INTO connector_reservations(connector_id,start_at,end_at,state) VALUES ($1,$2,$3,'confirmed')";
    await a.query(sql, [first, times.startAt, times.endAt]);
    secondInsert = b.query(sql, [first, times.startAt, times.endAt]).then(
      () => ({ ok: true, code: null }),
      (e) => ({ ok: false, code: e.code }),
    );
    const deadline = Date.now() + 3000;
    let blocked = false;
    while (Date.now() < deadline) {
      blocked = (
        await pool.query(
          "SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked",
          [pidB, pidA],
        )
      ).rows[0].blocked;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(
      blocked,
      "second real backend must block behind the first uncommitted insertion",
    );
    await a.query("COMMIT");
    assert.deepEqual(await secondInsert, { ok: false, code: "23P01" });
    await b.query("ROLLBACK");
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM connector_reservations WHERE state='confirmed'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await a.query("ROLLBACK");
    if (secondInsert) await secondInsert;
    await b.query("ROLLBACK");
    a.release();
    b.release();
  }
});
test("R13: parallel service holds for one specific port produce one winner and one 409", async () => {
  const times = interval(),
    results = await Promise.allSettled([
      createHold(pool, input(first, times)),
      createHold(pool, input(first, times)),
    ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert(rejected?.status === "rejected");
  assert.equal(rejected.reason.status, 409);
});
test("R14: concurrent automatic selection chooses distinct physical ports", async () => {
  const raw = { ...input(), connectorId: undefined };
  const [a, b] = await Promise.all([
    createHold(pool, raw),
    createHold(pool, raw),
  ]);
  assert.notEqual(a.connectorId, b.connectorId);
});
test("R15: driver availability is a read-only server estimate; adjacent and expired holds accounted for", async () => {
  const times = interval();
  const path =
    "/api/stations/tverskaya-plaza/availability?" + query(times.startAt);
  const initial = await request(path, driverToken);
  assert.equal(initial.status, 200);
  assert(initial.data.total >= 2);
  const held = await createHold(pool, input(first, times));
  const occupied = await request(path, driverToken);
  assert.equal(occupied.data.available, initial.data.available - 1);
  assert.equal(occupied.data.guaranteed, false);
  assert.equal(occupied.data.estimatedAmountKopecks, 40500);
  assert.equal(occupied.data.estimatedAmount, 405);
  assert.equal(occupied.data.estimateMethod, "power65-battery30");
  assert.equal(
    (
      await request(
        "/api/stations/tverskaya-plaza/availability?" + query(times.endAt),
        driverToken,
      )
    ).data.available,
    initial.data.available,
  );
  await releaseHold(pool, demoOrganizationId, held.id);
  assert.equal(
    (await request(path, driverToken)).data.available,
    initial.data.available,
  );
  await pool.query(
    `INSERT INTO connector_reservations(connector_id,start_at,end_at,expires_at,created_at)
    VALUES ($1,$2,$3,clock_timestamp()-interval '1 minute',clock_timestamp()-interval '2 minutes')`,
    [second, times.startAt, times.endAt],
  );
  assert.equal(
    (await request(path, driverToken)).data.available,
    initial.data.available,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM connector_reservations WHERE connector_id=$1",
        [second],
      )
    ).rows[0].state,
    "held",
    "GET does not update expired holds",
  );
});
test("R16: availability validates query/timezone/horizon and preserves role boundaries; writes stay closed", async () => {
  const path = "/api/stations/tverskaya-plaza/availability?" + query();
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, operatorToken)).status, 403);
  assert.equal((await request(path, "invalid")).status, 401);
  for (const suffix of [
    "start=bad&duration=60&connector=CCS2",
    query().replace("duration=60", "duration=0"),
    query() + "&organizationId=" + foreignOrg,
    query().replace("connector=CCS2", "connector=AC"),
    query(new Date(Date.now() - 60000).toISOString()),
    query(new Date(Date.now() + 5 * 86400000).toISOString()),
    "start=2026-02-30T12%3A00%3A00Z&duration=60&connector=CCS2",
    query().replace("Z&", "&"),
    query() + "&duration=90",
  ])
    assert.equal(
      (
        await request(
          "/api/stations/tverskaya-plaza/availability?" + suffix,
          driverToken,
        )
      ).status,
      400,
      suffix,
    );
  assert.equal(
    (
      await request(
        "/api/stations/missing/availability?" + query(),
        driverToken,
      )
    ).status,
    404,
  );
  assert.equal(
    (await request("/api/bookings", driverToken, "POST", {})).status,
    501,
  );
  assert.equal(
    (await request("/api/payments", driverToken, "POST", {})).status,
    400,
  );
  assert.equal(
    (await request("/api/reservations", driverToken, "POST", {})).status,
    404,
  );
});
test("R17: unavailable stations and fully held ports return zero availability and no price promise", async () => {
  const times = interval(),
    path = "/api/stations/tverskaya-plaza/availability?" + query(times.startAt);
  const total = (await request(path, driverToken)).data.total;
  for (let i = 0; i < total; i++)
    await createHold(pool, { ...input(first, times), connectorId: undefined });
  const full = await request(path, driverToken);
  assert.equal(full.data.available, 0);
  assert.equal(full.data.estimatedAmount, null);
  await assert.rejects(
    createHold(pool, { ...input(first, times), connectorId: undefined }),
    isStatus(409),
  );
  await pool.query(
    "UPDATE stations SET operating_state='service' WHERE id='tverskaya-plaza'",
  );
  const unavailable = await request(path, driverToken);
  assert.equal(unavailable.data.total, total);
  assert.equal(unavailable.data.available, 0);
  assert.equal(unavailable.data.estimatedAmountKopecks, null);
  await pool.query(
    "UPDATE stations SET operating_state='online' WHERE id='tverskaya-plaza'",
  );
  const missing = await request(
    "/api/stations/baumanskaya/availability?" + query(times.startAt),
    driverToken,
  );
  assert.equal(missing.data.total, 0);
  assert.equal(missing.data.available, 0);
  assert.equal(missing.data.estimatedAmount, null);
});
