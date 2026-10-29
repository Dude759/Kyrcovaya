import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { Server } from "node:http";
import "../src/config/env.js";
import { createPool, transaction, type Database } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { seed } from "../seeds/seed.js";
import { createApp } from "../src/app.js";
import { createPayment } from "../src/modules/payments/service.js";
import {
  startSession,
  stopSession,
  getSession,
  runChargingCycle,
} from "../src/modules/sessions/service.js";
import {
  SimulatorChargerAdapter,
  type ChargerAdapter,
} from "../src/modules/sessions/adapter.js";
import {
  confirmTestSessionRefund,
  recoverSessionRefund,
} from "../src/modules/sessions/settlement.js";

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith("_test"))
  throw new Error("Dedicated _test PostgreSQL required");
import {
  cancelBooking,
  recoverBookingLifecycle,
  recoverBookingRefund,
  confirmTestBookingRefund,
} from "../src/modules/bookings/service.js";
import { finalizePayment } from "../src/modules/payments/finalization.js";
import { processSignedEvent } from "../src/modules/payments/service.js";
import { signEvent } from "../src/modules/payments/provider.js";
const schema = `test_${randomBytes(10).toString("hex")}`,
  admin = createPool(connection);
let pool: Database,
  adapter: SimulatorChargerAdapter,
  driver: string,
  other: string,
  operator: string,
  foreignOperator: string,
  server: Server,
  base: string;
const tokens: Record<string, string> = {};
const password = "ChargingFixture12345";
const identity = (id = driver) => ({ id, role: "driver" });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function count(table: string) {
  return (await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
}
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  token = tokens[driver],
  key?: string,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    data: response.status === 204 ? null : ((await response.json()) as any),
  };
}
// Paid historical fixtures are INSERTed consistently; no immutable snapshot is rewritten to move time.
async function paid({
  user = driver,
  offset = -1000,
  duration = 30,
  port = 0,
  prepaid = 10000,
  tariff = 1800,
  startAt = undefined as Date | undefined,
} = {}) {
  const selected = (
    await pool.query(
      "SELECT c.*,s.organization_id FROM connectors c JOIN stations s ON s.id=c.station_id WHERE c.station_id='tverskaya-plaza' AND type='CCS2' ORDER BY c.id OFFSET $1 LIMIT 1",
      [port],
    )
  ).rows[0];
  assert(selected, "Physical fixture port missing");
  const id = randomUUID(),
    bid = randomUUID(),
    rid = randomUUID(),
    aid = randomUUID(),
    start = startAt ?? new Date(Date.now() + offset),
    end = new Date(start.getTime() + duration * 60000),
    created = new Date(start.getTime() - 3600000),
    expiry = new Date(start.getTime() - 1000);
  await transaction(pool, async (db) => {
    await db.query(
      `INSERT INTO payments(id,user_id,organization_id,station_id,connector_id,requested_connector_type,start_at,end_at,method,amount_kopecks,quoted_tariff_kopecks,quoted_energy_kwh,idempotency_key,request_hash,expires_at,created_at,provider_success_received_at)
   VALUES($1,$2,$3,$4,$5,'CCS2',$6,$7,'card',$8,$9,1,$10,$11,$12,$13,$13)`,
      [
        id,
        user,
        selected.organization_id,
        selected.station_id,
        selected.id,
        start,
        end,
        prepaid,
        tariff,
        randomUUID(),
        "a".repeat(64),
        expiry,
        created,
      ],
    );
    await db.query(
      "INSERT INTO connector_reservations(id,connector_id,start_at,end_at,state,expires_at,created_at,payment_id,booking_id) VALUES($1,$2,$3,$4,'confirmed',$5,$6,$7,$8)",
      [rid, selected.id, start, end, expiry, created, id, bid],
    );
    await db.query(
      "INSERT INTO payment_attempts(id,payment_id,attempt_no,provider_payment_id,status,confirmation_url,created_at,resolved_at) VALUES($1,$2,1,$1::uuid::text,'succeeded','https://provider.example.test',$3,$3)",
      [aid, id, created],
    );
    await db.query(
      `INSERT INTO bookings(id,payment_id,reservation_id,payment_attempt_id,user_id,organization_id,station_id,connector_id,connector_type,start_at,end_at,amount_kopecks,method,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'CCS2',$9,$10,$11,'card',$12)`,
      [
        bid,
        id,
        rid,
        aid,
        user,
        selected.organization_id,
        selected.station_id,
        selected.id,
        start,
        end,
        prepaid,
        created,
      ],
    );
    await db.query(
      "UPDATE payments SET status='succeeded',booking_id=$2,finalized_at=$3 WHERE id=$1",
      [id, bid, created],
    );
  });
  await pool.query(
    "INSERT INTO simulator_devices(connector_id,command_delay_ms) VALUES($1,0) ON CONFLICT(connector_id) DO UPDATE SET command_delay_ms=0",
    [selected.id],
  );
  return {
    id: bid,
    paymentId: id,
    attemptId: aid,
    connectorId: selected.id,
    userId: user,
    start,
    end,
  };
}
const start = async (b: any, key = randomUUID()) =>
  startSession(pool, b.userId, b.id, key);
const current = (s: any, id = driver) =>
  getSession(pool, s.id, identity(id)) as Promise<any>;
const cycle = () => runChargingCycle(pool, adapter);
async function tick(s: any, seconds = 10) {
  await pool.query(
    "UPDATE simulator_session_state SET last_tick_at=clock_timestamp()-($2::int*interval '1 second') WHERE session_id=$1",
    [s.id, seconds],
  );
  await cycle();
  return current(s);
}
async function active(b = undefined as any) {
  b ??= await paid();
  const s = await start(b);
  await cycle();
  assert.equal((await current(s, b.userId)).status, "active");
  return s;
}
async function finish(s: any) {
  await stopSession(pool, driver, s.id, randomUUID());
  await cycle();
  return current(s);
}
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = createPool(connection, schema);
  await migrate(pool);
  await seed(pool, password, password);
  const org = randomUUID();
  await pool.query(
    "INSERT INTO organizations(id,name,network_limit_kw) VALUES($1,'Other organization',100)",
    [org],
  );
  await pool.query(
    "INSERT INTO users(email_normalized,password_hash,name,role,organization_id) SELECT 'foreign.operator@fixture.test',password_hash,'Other operator','operator',$1 FROM users WHERE email_normalized='operator@energotransport.test'",
    [org],
  );
  server = createApp(pool, { origins: [], AUTH_TTL_SECONDS: 3600 }).listen(
    0,
    "127.0.0.1",
  );
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  for (const email of [
    "driver@energotransport.test",
    "driver2@energotransport.test",
    "operator@energotransport.test",
    "foreign.operator@fixture.test",
  ]) {
    const role = email.includes("operator") ? "operator" : "driver";
    const r = await request(
      "/api/auth/login",
      "POST",
      { email, password, role },
      "",
    );
    assert.equal(r.status, 200);
    tokens[r.data.user.id] = r.data.token;
    if (email.startsWith("driver@")) driver = r.data.user.id;
    else if (email.startsWith("driver2")) other = r.data.user.id;
    else if (email.startsWith("foreign")) foreignOperator = r.data.user.id;
    else operator = r.data.user.id;
  }
});
beforeEach(async () => {
  await pool.query(
    "UPDATE stations SET archived_at=null; UPDATE connectors SET archived_at=null",
  );
  await pool.query("TRUNCATE payments,connector_reservations CASCADE");
  await pool.query(
    "UPDATE simulator_devices SET online=true,reject_start=false,command_delay_ms=0",
  );
  await pool.query(
    "UPDATE stations SET operating_state='online',limit_kw=max_power_kw",
  );
  await pool.query("UPDATE connectors SET operating_state='idle'");
  await pool.query("UPDATE driver_profiles SET battery_capacity_kwh=75");
  adapter = new SimulatorChargerAdapter(pool);
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await pool?.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

async function processServer() {
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
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Child startup timeout"));
    }, 15000);
    child.stdout?.on("data", (c) => {
      const m = String(c).match(/API listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Child exited"));
    });
  });
  return { child, address };
}
async function stopProcess(child: ChildProcess) {
  const done = once(child, "exit");
  child.kill();
  await done;
}
const stationInput = {
  name: "Учебная новая",
  address: "Учебный адрес 10",
  district: "Демо",
  coordinates: [37.6, 55.7],
  maxPowerKw: 100,
  limitKw: 100,
  pricePerKwh: 18,
};
const op = (path: string, method = "GET", body?: unknown, key?: string) =>
  request("/api/operator/" + path, method, body, tokens[operator], key);
async function created() {
  const r = await op("stations", "POST", stationInput, randomUUID());
  assert.equal(r.status, 201);
  return r.data;
}
async function port(s: any, label = "A") {
  const r = await op(
    `stations/${s.id}/connectors`,
    "POST",
    { label, type: "CCS2", maxPowerKw: 50, status: "idle" },
    randomUUID(),
  );
  assert.equal(r.status, 201);
  return r.data;
}
test("O00: create service station, port, activate and driver sees server coordinates", async () => {
  const s = await created();
  assert.equal(s.status, "service");
  assert.equal(
    (await op(`stations/${s.id}`, "PATCH", { status: "online" })).status,
    409,
  );
  await port(s);
  assert.equal(
    (await op(`stations/${s.id}`, "PATCH", { status: "online" })).status,
    200,
  );
  const d = await request("/api/stations/" + s.id);
  assert.deepEqual(d.data.coordinates, stationInput.coordinates);
  assert.equal(d.data.connectors[0].available, 1);
});
test("O01: concurrent idempotent creates and changed payload conflict", async () => {
  const key = randomUUID();
  const r = await Promise.all([
    op("stations", "POST", stationInput, key),
    op("stations", "POST", stationInput, key),
  ]);
  assert.equal(r[0].data.id, r[1].data.id);
  assert.equal(
    (await op("stations", "POST", { ...stationInput, name: "Другой" }, key))
      .status,
    409,
  );
  const s = r[0].data;
  const k = randomUUID(),
    v = { label: "A", type: "CCS2", maxPowerKw: 22, status: "idle" };
  const p = await Promise.all([
    op(`stations/${s.id}/connectors`, "POST", v, k),
    op(`stations/${s.id}/connectors`, "POST", v, k),
  ]);
  assert.equal(p[0].data.id, p[1].data.id);
});
test("O02: driver forbidden, organization cannot be injected and foreign operator isolated", async () => {
  const s = await created();
  assert.equal(
    (await request("/api/operator/stations", "POST", stationInput)).status,
    403,
  );
  assert.equal(
    (
      await op(
        "stations",
        "POST",
        { ...stationInput, organizationId: randomUUID() },
        randomUUID(),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/operator/stations/" + s.id,
        "PATCH",
        { name: "Xx" },
        tokens[foreignOperator],
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        "/api/operator/stations/" + s.id + "/connectors",
        "GET",
        undefined,
        tokens[foreignOperator],
      )
    ).status,
    404,
  );
});
test("O03: strict coordinate, price, power and unknown fields validation", async () => {
  for (const v of [
    { coordinates: [181, 55] },
    { coordinates: [37, 91] },
    { pricePerKwh: -1 },
    { maxPowerKw: 0 },
    { pricePerKwh: 1.234 },
    { status: "online" },
    { secret: "x" },
  ])
    assert.equal(
      (await op("stations", "POST", { ...stationInput, ...v }, randomUUID()))
        .status,
      400,
    );
  const s = await created();
  assert.equal(
    (
      await op(
        `stations/${s.id}/connectors`,
        "POST",
        { label: "X", type: "fake", maxPowerKw: 1, status: "idle" },
        randomUUID(),
      )
    ).status,
    400,
  );
});
test("O04: paid future reservation blocks service and archives; snapshot tariff stays fixed", async () => {
  const b = await paid({ offset: 60000 });
  for (const path of [
    "stations/tverskaya-plaza/archive",
    "connectors/" + b.connectorId + "/archive",
  ])
    assert.equal((await op(path, "POST", {})).status, 409);
  assert.equal(
    (await op("stations/tverskaya-plaza", "PATCH", { status: "service" }))
      .status,
    409,
  );
  assert.equal(
    (await op("stations/tverskaya-plaza", "PATCH", { pricePerKwh: 30 })).status,
    200,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT quoted_tariff_kopecks FROM payments WHERE id=$1",
        [b.paymentId],
      )
    ).rows[0].quoted_tariff_kopecks,
    1800,
  );
});
test("O05: unfinished load blocks reduction and archive, including starting state", async () => {
  const b = await paid();
  const s = await start(b);
  assert.equal(
    (await op("stations/tverskaya-plaza", "PATCH", { limitKw: 1 })).status,
    409,
  );
  assert.equal(
    (await op("connectors/" + b.connectorId, "PATCH", { maxPowerKw: 1 }))
      .status,
    409,
  );
  assert.equal(
    (await op("connectors/" + b.connectorId + "/archive", "POST", {})).status,
    409,
  );
  await cycle();
  assert.equal((await current(s)).status, "active");
});
test("O06: archive historical object retains IDs and historical detail while catalog excludes it", async () => {
  const b = await paid({ offset: -3600000 });
  await recoverBookingLifecycle(pool);
  assert.equal(
    (await op("connectors/" + b.connectorId + "/archive", "POST", {})).status,
    200,
  );
  assert.equal(
    (await op("stations/tverskaya-plaza/archive", "POST", {})).status,
    200,
  );
  assert(
    !(await request("/api/stations")).data.items.some(
      (s: any) => s.id === "tverskaya-plaza",
    ),
  );
  assert.equal(
    (await request("/api/stations/tverskaya-plaza")).data.name,
    "Тверская Plaza",
  );
  assert(
    (await request("/api/workspace")).data.stations.some(
      (s: any) => s.id === "tverskaya-plaza",
    ),
  );
  assert.equal(
    (
      await pool.query("SELECT count(*)::int n FROM bookings WHERE id=$1", [
        b.id,
      ])
    ).rows[0].n,
    1,
  );
});
test("O07: audit actor and stable pagination scoped to organization", async () => {
  const s = await created();
  await port(s);
  await op("stations/" + s.id, "PATCH", { name: "Обновлена" });
  const a = await op("events?limit=1");
  assert.equal(a.data.items[0].actorId, operator);
  assert.equal(a.data.items[0].stationId, s.id);
  assert.equal(a.data.items[0].action, "station_updated");
  assert(a.data.nextCursor);
  const b = await op("events?limit=1&cursor=" + a.data.nextCursor);
  assert.notEqual(a.data.items[0].id, b.data.items[0].id);
  assert.equal(
    (
      await request(
        "/api/operator/events",
        "GET",
        undefined,
        tokens[foreignOperator],
      )
    ).data.items.length,
    0,
  );
});
test("O08: audit failure rolls back object and idempotency record", async () => {
  await pool.query(
    "CREATE FUNCTION break_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failure'; END $$; CREATE TRIGGER break_audit BEFORE INSERT ON network_events FOR EACH ROW EXECUTE FUNCTION break_audit()",
  );
  const key = randomUUID();
  const before = (await pool.query("SELECT count(*)::int n FROM stations"))
    .rows[0].n;
  try {
    assert.equal((await op("stations", "POST", stationInput, key)).status, 500);
  } finally {
    await pool.query(
      "DROP TRIGGER break_audit ON network_events; DROP FUNCTION break_audit()",
    );
  }
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM stations")).rows[0].n,
    before,
  );
  assert.equal((await op("stations", "POST", stationInput, key)).status, 201);
});
test("O09: server restart and new login preserve stations and audit", async () => {
  const s = await created();
  await port(s);
  const child = await processServer();
  try {
    const r = await fetch(child.address + "/api/operator/stations", {
      headers: { Authorization: "Bearer " + tokens[operator] },
    });
    assert(((await r.json()) as any).items.some((x: any) => x.id === s.id));
  } finally {
    await stopProcess(child.child);
  }
  const login = await request(
    "/api/auth/login",
    "POST",
    { email: "operator@energotransport.test", password, role: "operator" },
    "",
  );
  assert.equal(login.status, 200);
  assert(
    (
      await request(
        "/api/operator/stations",
        "GET",
        undefined,
        login.data.token,
      )
    ).data.items.some((x: any) => x.id === s.id),
  );
});
test("O10: driver pays and books the newly created physical port using server catalog only", async () => {
  const s = await created();
  const p = await port(s);
  await op("stations/" + s.id, "PATCH", { status: "online" });
  const options = {
    publicOrigin: "https://provider.fixture.test",
    secret: "p".repeat(48),
  };
  const order = await createPayment(pool, options, driver, randomUUID(), {
    input: {
      stationId: s.id,
      connector: "CCS2",
      start: new Date(Date.now() + 60000).toISOString(),
      duration: 30,
      payment: "card",
    },
  });
  const payment = order.payment;
  const provider = (
    await pool.query(
      "SELECT provider_payment_id FROM payment_attempts WHERE id=$1",
      [payment.attempt!.id],
    )
  ).rows[0].provider_payment_id;
  const e = signEvent(options, {
    providerEventId: randomUUID(),
    providerPaymentId: provider,
    outcome: "succeeded",
    amountKopecks: Math.round(payment.amount * 100),
    currency: "RUB",
  });
  await processSignedEvent(pool, options, e.body, e.timestamp, e.signature);
  const b = (
    await pool.query("SELECT * FROM bookings WHERE payment_id=$1", [payment.id])
  ).rows[0];
  assert.equal(b.connector_id, p.id);
  assert.equal(b.station_id, s.id);
});
test("O11: online station can archive after all its ports are archived", async () => {
  const s = await created();
  const p = await port(s);
  assert.equal(
    (await op("stations/" + s.id, "PATCH", { status: "online" })).status,
    200,
  );
  assert.equal(
    (await op("connectors/" + p.id + "/archive", "POST", {})).status,
    200,
  );
  assert.equal(
    (await op("stations/" + s.id + "/archive", "POST", {})).status,
    200,
  );
});
async function booking(b: any) {
  return (
    await request("/api/workspace", "GET", undefined, tokens[b.userId])
  ).data.bookings.find((x: any) => x.id === b.id);
}
async function reservation(b: any) {
  return (
    await pool.query(
      "SELECT state FROM connector_reservations WHERE booking_id=$1",
      [b.id],
    )
  ).rows[0].state;
}
async function closed(b: any) {
  await recoverBookingLifecycle(pool);
  return booking(b);
}
