import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
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
  station = "tverskaya-plaza",
  startAt = undefined as Date | undefined,
} = {}) {
  const selected = (
    await pool.query(
      "SELECT c.*,s.organization_id FROM connectors c JOIN stations s ON s.id=c.station_id WHERE c.station_id=$2 AND type='CCS2' ORDER BY c.id OFFSET $1 LIMIT 1",
      [port, station],
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
    "TRUNCATE power_dispatch_settings,power_dispatch_actions,grid_states,grid_samples,grid_requests,grid_actions CASCADE",
  );
  await pool.query("TRUNCATE power_measurements");
  await pool.query(
    "UPDATE stations SET archived_at=null; UPDATE connectors SET archived_at=null",
  );
  await pool.query("TRUNCATE payments,connector_reservations CASCADE");
  await pool.query(
    "UPDATE simulator_devices SET online=true,reject_start=false,reject_power=false,command_delay_ms=0",
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

import { integrateEnergy } from "../src/modules/sessions/adapter.js";
import {
  planDispatch,
  runPowerDispatch,
  acknowledgePowerReceipt,
  livePowerInput,
} from "../src/modules/sessions/power.js";
const op = (path: string, method = "GET", body?: unknown, key = randomUUID()) =>
  request("/api/operator" + path, method, body, tokens[operator], key);
const scenario = (s: string, workload = "live") =>
  op("/grid/scenario", "POST", { scenario: s, workload });
const org = async () =>
  (
    await pool.query("SELECT organization_id FROM users WHERE id=$1", [
      operator,
    ])
  ).rows[0].organization_id;
const state = async (s: any) =>
  (
    await pool.query("SELECT * FROM session_power_state WHERE session_id=$1", [
      s.id,
    ])
  ).rows[0];
const latest = async (s: any) =>
  (
    await pool.query(
      "SELECT * FROM power_commands WHERE session_id=$1 ORDER BY revision DESC LIMIT 1",
      [s.id],
    )
  ).rows[0];
async function enable() {
  assert.equal((await scenario("normal")).status, 200);
  assert.equal(
    (await op("/power/dispatch", "POST", { enabled: true })).status,
    200,
  );
}
async function pair() {
  await enable();
  const a = await active();
  const b = await active(await paid({ user: other, port: 1 }));
  return [a, b];
}
const dispatch = () => runPowerDispatch(pool, adapter);

test("D00: migration repeat, OFF default, immutable state/history/receipt and retained shadow constraints", async () => {
  await migrate(pool);
  assert.equal(await count("schema_migrations"), 10);
  assert.equal((await op("/power/dispatch")).data.enabled, false);
  const s = await active();
  await assert.rejects(
    pool.query(
      "UPDATE session_power_state SET acknowledged_w=123 WHERE session_id=$1",
      [s.id],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query(
      "UPDATE session_power_history SET power_w=1 WHERE session_id=$1",
      [s.id],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query(
      "UPDATE charging_sessions SET allocated_power_w=10000 WHERE id=$1",
      [s.id],
    ),
    { code: "23514" },
  );
  assert.equal(
    (await op("/power/dispatch", "POST", { enabled: true })).status,
    409,
  );
});
test("D01: two physical ports 22→10→0→10→22 kW with receipts and unchanged initial snapshot", async () => {
  const ss = await pair();
  for (const [sc, w] of [
    ["deep_deficit", 10000],
    ["offline", 0],
    ["deep_deficit", 10000],
    ["recovery", 22000],
  ] as const) {
    await scenario(sc);
    await dispatch();
    for (const s of ss) {
      assert.equal(Number((await state(s)).acknowledged_w), w);
      assert.equal((await latest(s)).status, "acknowledged");
    }
  }
  assert.equal(await count("power_command_receipts"), 8);
  assert.deepEqual(
    (
      await pool.query("SELECT allocated_power_w::int w FROM charging_sessions")
    ).rows.map((r) => r.w),
    [22000, 22000],
  );
  assert.equal((await op("/power/dispatch")).data.withinBudget, true);
});
test("D02: exact integer segmented integration: 10s×22kW + 10s×10kW = 88Wh + 3200000 Wms", () => {
  const a = integrateEnergy(0, 0, 22000, 10000, 10000),
    b = integrateEnergy(a.energy, a.remainder, 10000, 10000, 10000);
  assert.deepEqual(a, { energy: 61, remainder: 400000 });
  assert.deepEqual(b, { energy: 88, remainder: 3200000 });
  assert.deepEqual(integrateEnergy(b.energy, b.remainder, 0, 10000, 10000), b);
});
test("D03: adapter closes old-power interval at effective_at and preserves integer remainder", async () => {
  const [s] = await pair();
  await scenario("deep_deficit");
  await planDispatch(pool, await org());
  const c = await latest(s);
  await pool.query(
    "UPDATE simulator_session_state SET last_tick_at=clock_timestamp()-interval '10 seconds' WHERE session_id=$1",
    [s.id],
  );
  const before = (
    await pool.query(
      "SELECT * FROM simulator_session_state WHERE session_id=$1",
      [s.id],
    )
  ).rows[0];
  const r = await adapter.setPower(c.id);
  const after = (
    await pool.query(
      "SELECT * FROM simulator_session_state WHERE session_id=$1",
      [s.id],
    )
  ).rows[0];
  const expected = integrateEnergy(
    Number(before.energy_wh),
    Number(before.remainder_watt_ms),
    22000,
    r.effective_at - before.last_tick_at,
    10000,
  );
  assert.equal(Number(after.energy_wh), expected.energy);
  assert.equal(Number(after.remainder_watt_ms), expected.remainder);
  assert.equal(after.last_tick_at.toISOString(), r.effective_at.toISOString());
  const m = (
    await pool.query("SELECT * FROM session_measurements WHERE id=$1", [
      r.measurement_id,
    ])
  ).rows[0];
  assert.equal(Number(m.power_w), 10000);
  assert.equal(m.sampled_at.toISOString(), r.effective_at.toISOString());
  await acknowledgePowerReceipt(pool, c.id);
});
test("D04: delayed command remains pending, reports transient excess and blocks starts; no premature acknowledgement", async () => {
  const [s] = await pair();
  await pool.query(
    "UPDATE simulator_devices SET command_delay_ms=300 WHERE connector_id=(SELECT connector_id FROM charging_sessions WHERE id=$1)",
    [s.id],
  );
  await scenario("deep_deficit");
  await dispatch();
  const c = await latest(s);
  assert.equal(c.status, "submitted");
  assert.equal(Number((await state(s)).acknowledged_w), 22000);
  const view = (await op("/power/dispatch")).data;
  assert.equal(view.withinBudget, false);
  assert.equal(view.status, "degraded");
  await delay(330);
  await dispatch();
  assert.equal((await latest(s)).status, "acknowledged");
});
test("D05: lost reply recovers same receipt without second physical effect or reading", async () => {
  const [s] = await pair();
  await scenario("deep_deficit");
  await planDispatch(pool, await org());
  const c = await latest(s);
  const a = await adapter.setPower(c.id),
    n = await count("session_measurements");
  assert.equal((await latest(s)).status, "pending");
  const b = await adapter.setPower(c.id);
  assert.equal(a.measurement_id, b.measurement_id);
  assert.equal(await count("session_measurements"), n);
  await dispatch();
  assert.equal((await latest(s)).status, "acknowledged");
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM power_command_receipts WHERE command_id=$1",
        [c.id],
      )
    ).rows[0].n,
    1,
  );
});
test("D06: superseded out-of-order command never overwrites newer confirmed state", async () => {
  const [s] = await pair();
  await scenario("deep_deficit");
  await planDispatch(pool, await org());
  const old = await latest(s);
  await scenario("offline");
  await planDispatch(pool, await org());
  const newer = await latest(s);
  const r = await adapter.setPower(newer.id);
  assert.equal(r.accepted, true);
  const stale = await adapter.setPower(old.id);
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, "superseded");
  assert.equal(Number((await state(s)).acknowledged_w), 0);
  await acknowledgePowerReceipt(pool, old.id);
  await acknowledgePowerReceipt(pool, newer.id);
  assert.equal(Number((await state(s)).acknowledged_w), 0);
});
test("D07: device rejection is durable and visible, retries only after material device/input change", async () => {
  const [s] = await pair();
  await pool.query(
    "UPDATE simulator_devices SET reject_power=true WHERE connector_id=(SELECT connector_id FROM charging_sessions WHERE id=$1)",
    [s.id],
  );
  await scenario("deep_deficit");
  await dispatch();
  const c = await latest(s);
  assert.equal(c.status, "rejected");
  assert.equal(Number((await state(s)).acknowledged_w), 22000);
  await dispatch();
  assert.equal((await latest(s)).id, c.id);
  await pool.query(
    "UPDATE simulator_devices SET reject_power=false WHERE connector_id=(SELECT connector_id FROM charging_sessions WHERE id=$1)",
    [s.id],
  );
  await dispatch();
  assert.equal(Number((await state(s)).acknowledged_w), 10000);
});
test("D08: changed local limit or port status invalidates saved plan before delivery", async () => {
  const [s] = await pair();
  await scenario("deep_deficit");
  await planDispatch(pool, await org());
  const c = await latest(s);
  await pool.query(
    "UPDATE stations SET limit_kw=100 WHERE id='tverskaya-plaza'",
  );
  const r = await adapter.setPower(c.id);
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "input_changed");
  await acknowledgePowerReceipt(pool, c.id);
  await planDispatch(pool, await org());
  const next = await latest(s);
  await pool.query(
    "UPDATE connectors SET operating_state='offline' WHERE id=(SELECT connector_id FROM charging_sessions WHERE id=$1)",
    [s.id],
  );
  assert.equal((await adapter.setPower(next.id)).reason, "input_changed");
});
test("D09: stale/offline/missing Grid never admits starts and only requests confirmed pause", async () => {
  await enable();
  for (const sc of ["stale", "offline", "missing"]) {
    await scenario(sc);
    const b = await paid();
    await assert.rejects(start(b), { status: 409 });
    await pool.query("TRUNCATE payments,connector_reservations CASCADE");
  }
  await scenario("normal");
  const s = await active();
  await scenario("stale");
  await dispatch();
  assert.equal(Number((await state(s)).acknowledged_w), 0);
  assert.equal((await current(s)).status, "active");
  assert.equal((await op("/power/dispatch")).data.grid.budgetW, null);
});
test("D10: device offline preserves pending power and occupied port, reconnect has no gap backfill", async () => {
  const [s] = await pair();
  await pool.query(
    "UPDATE simulator_devices SET online=false WHERE connector_id=(SELECT connector_id FROM charging_sessions WHERE id=$1)",
    [s.id],
  );
  const before = await current(s);
  await scenario("offline");
  await dispatch();
  assert.equal((await latest(s)).status, "submitted");
  assert.equal(Number((await state(s)).acknowledged_w), 22000);
  await pool.query(
    "UPDATE simulator_session_state SET last_tick_at=clock_timestamp()-interval '90 seconds' WHERE session_id=$1",
    [s.id],
  );
  await pool.query(
    "UPDATE simulator_devices SET online=true WHERE connector_id=(SELECT connector_id FROM charging_sessions WHERE id=$1)",
    [s.id],
  );
  await dispatch();
  assert.equal(Number((await state(s)).acknowledged_w), 0);
  assert.equal((await current(s)).energyWh, before.energyWh);
  assert.equal((await current(s)).telemetryGap, true);
});
test("D11: parallel delivery/start/stop keeps one settlement/refund and rejects late power on stopped session", async () => {
  const [s, b] = await pair();
  await scenario("deep_deficit");
  await planDispatch(pool, await org());
  const c = await latest(s);
  await Promise.all([
    adapter.setPower(c.id),
    adapter.setPower(c.id),
    startSession(pool, driver, s.bookingId, randomUUID()),
    stopSession(pool, driver, s.id, randomUUID()),
  ]);
  await cycle();
  await cycle();
  assert.equal((await current(s)).status, "completed");
  assert.equal(Number((await state(s)).acknowledged_w), 0);
  await Promise.all([cycle(), cycle()]);
  assert.equal(await count("session_settlements"), 1);
  assert.equal(await count("test_session_refund_receipts"), 1);
  assert.equal((await current(b, other)).status, "active");
});
test("D12: SQL rollback after physical receipt leaves no partial interval/state/receipt", async () => {
  const [s] = await pair();
  await scenario("deep_deficit");
  await planDispatch(pool, await org());
  const c = await latest(s),
    n = await count("session_measurements");
  await pool.query(
    `CREATE FUNCTION reject_power_history_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.power_command_id IS NOT NULL THEN RAISE EXCEPTION 'injected rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_power_history_test BEFORE INSERT ON session_power_history FOR EACH ROW EXECUTE FUNCTION reject_power_history_test()`,
  );
  try {
    await assert.rejects(adapter.setPower(c.id), /injected rollback/);
  } finally {
    await pool.query(
      "DROP TRIGGER reject_power_history_test ON session_power_history; DROP FUNCTION reject_power_history_test()",
    );
  }
  assert.equal(await count("power_command_receipts"), 0);
  assert.equal(await count("session_measurements"), n);
  assert.equal(Number((await state(s)).acknowledged_w), 22000);
  assert.equal((await adapter.setPower(c.id)).accepted, true);
});
test("D13: actual Node restart reconciles durable receipt and marks telemetry gap without energy backfill", async () => {
  const [s] = await pair();
  await scenario("deep_deficit");
  await planDispatch(pool, await org());
  const c = await latest(s);
  await adapter.setPower(c.id);
  const before = await current(s);
  await pool.query(
    "UPDATE simulator_session_state SET last_tick_at=clock_timestamp()-interval '90 seconds' WHERE session_id=$1",
    [s.id],
  );
  const child = await processServer();
  try {
    for (let i = 0; i < 40; i++) {
      if (
        (await current(s)).telemetryGap &&
        (await latest(s)).status === "acknowledged"
      )
        break;
      await delay(100);
    }
    assert.equal((await latest(s)).status, "acknowledged");
    assert.equal((await current(s)).energyWh, before.energyWh);
    assert.equal((await current(s)).telemetryGap, true);
  } finally {
    await stopProcess(child.child);
  }
});
test("D14: organization isolation, driver forbidden, training never drives live sessions, switching with active sessions refused", async () => {
  await enable();
  assert.equal((await scenario("normal", "training")).status, 409);
  const s = await active();
  assert.equal(
    (await op("/power/dispatch", "POST", { enabled: false })).status,
    409,
  );
  assert.equal((await request("/api/operator/power/dispatch")).status, 403);
  const foreign = await request(
    "/api/operator/power/dispatch",
    "GET",
    undefined,
    tokens[foreignOperator],
  );
  assert.equal(foreign.data.sessions.length, 0);
  assert.equal(foreign.data.enabled, false);
  assert.equal(foreign.data.history.length, 0);
  await assert.rejects(
    pool.query(
      "UPDATE session_measurements SET power_w=1 WHERE session_id=$1",
      [s.id],
    ),
    { code: "23514" },
  );
});
test("D15: two stations share one 20kW network budget and stable allocation regardless input order", async () => {
  await enable();
  const a = await active();
  const station = (
    await pool.query(
      "SELECT station_id FROM connectors WHERE station_id<>'tverskaya-plaza' AND type='CCS2' ORDER BY station_id LIMIT 1",
    )
  ).rows[0].station_id;
  const b = await active(await paid({ user: other, station }));
  await scenario("deep_deficit");
  await dispatch();
  assert.equal(Number((await state(a)).acknowledged_w), 10000);
  assert.equal(Number((await state(b)).acknowledged_w), 10000);
  const { maxMin } = await import("../src/modules/operator/grid-engine.js");
  const organization = await org();
  const input = await transaction(pool, (db) =>
    livePowerInput(db, organization),
  );
  const demands = input.assignments.map(({ plannedW, ...d }) => d);
  assert.deepEqual(
    maxMin(demands, 20000),
    maxMin([...demands].reverse(), 20000),
  );
});
test("D16: parallel starts share Grid admission lock; second cannot overcommit budget", async () => {
  await pool.query("UPDATE organizations SET network_limit_kw=40 WHERE id=$1", [
    await org(),
  ]);
  try {
    await enable();
    const a = await paid(),
      b = await paid({ user: other, port: 1 });
    const results = await Promise.allSettled([start(a), start(b)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(await count("charging_sessions"), 1);
    await cycle();
    assert.equal((await op("/power/dispatch")).data.acknowledgedW, 22000);
  } finally {
    await pool.query(
      "UPDATE organizations SET network_limit_kw=4000 WHERE id=$1",
      [await org()],
    );
  }
});
test("D17: acknowledged zero pause still ends at booking deadline with one exact settlement and refund", async () => {
  await enable();
  const b = await paid({ offset: -10, duration: 0.04 }),
    s = await active(b);
  await scenario("offline");
  await dispatch();
  assert.equal(Number((await state(s)).acknowledged_w), 0);
  await delay(2450);
  await cycle();
  await cycle();
  const done = await current(s);
  assert.equal(done.status, "completed");
  assert.equal(done.stopReason, "reservation_end");
  assert.equal(
    done.settlement.finalCostKopecks,
    Math.ceil((done.energyWh * 1800) / 1000),
  );
  assert.equal(
    done.refund.amountKopecks,
    10000 - done.settlement.finalCostKopecks,
  );
  await cycle();
  assert.equal(await count("session_settlements"), 1);
  assert.equal(await count("test_session_refund_receipts"), 1);
  assert.equal(
    (await op("/power/dispatch", "POST", { enabled: false })).status,
    200,
  );
});
test("D18: upgrade from actual 001–009 with lost start reply reconstructs acknowledged power without enrolling legacy session", async () => {
  const upgradeSchema = `test_${randomBytes(10).toString("hex")}`,
    original = pool;
  await admin.query(`CREATE SCHEMA ${upgradeSchema}`);
  const old = createPool(connection!, upgradeSchema);
  try {
    await old.query(
      "CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await readdir("migrations"))
      .filter((n) => /^00[1-9]_/.test(n))
      .sort()) {
      const sql = (await readFile("migrations/" + name, "utf8")).replaceAll(
        "\r\n",
        "\n",
      );
      await old.query(sql);
      await old.query(
        "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
        [name, createHash("sha256").update(sql).digest("hex")],
      );
    }
    await seed(old, password, password);
    pool = old;
    const legacyUser = (
      await old.query(
        "SELECT id FROM users WHERE email_normalized='driver@energotransport.test'",
      )
    ).rows[0].id;
    const b = await paid({ user: legacyUser });
    const sid = await transaction(old, async (db) => {
      const s = (
        await db.query(
          `INSERT INTO charging_sessions(booking_id,payment_id,funding_attempt_id,user_id,organization_id,station_id,connector_id,connector_type,window_start,window_end,prepaid_kopecks,tariff_kopecks,energy_budget_wh,allocated_power_w,battery_capacity_kwh)
    SELECT b.id,p.id,b.payment_attempt_id,b.user_id,b.organization_id,b.station_id,b.connector_id,b.connector_type,b.start_at,b.end_at,p.amount_kopecks,p.quoted_tariff_kopecks,5000,22000,75 FROM bookings b JOIN payments p ON p.id=b.payment_id WHERE b.id=$1 RETURNING id`,
          [b.id],
        )
      ).rows[0].id;
      await db.query(
        "INSERT INTO simulator_session_state(session_id,state,last_tick_at) VALUES($1,'charging',clock_timestamp())",
        [s],
      );
      const m = (
        await db.query(
          "INSERT INTO session_measurements(session_id,sequence_no,energy_wh,power_w) VALUES($1,0,0,22000) RETURNING id",
          [s],
        )
      ).rows[0].id;
      await db.query(
        "UPDATE simulator_session_state SET sequence_no=0 WHERE session_id=$1",
        [s],
      );
      await db.query(
        "UPDATE charging_sessions SET last_sequence=0,measured_at=(SELECT sampled_at FROM session_measurements WHERE id=$2) WHERE id=$1",
        [s, m],
      );
      const c = (
        await db.query(
          "INSERT INTO charging_commands(session_id,kind,status,ready_at) VALUES($1,'start','submitted',clock_timestamp()) RETURNING id",
          [s],
        )
      ).rows[0].id;
      await db.query(
        "INSERT INTO simulator_command_receipts(command_id,session_id,accepted,measurement_id) VALUES($1,$2,true,$3)",
        [c, s, m],
      );
      return s;
    });
    await migrate(old);
    const st = await state({ id: sid });
    assert.equal(st.managed, false);
    assert.equal(Number(st.acknowledged_w), 22000);
    await runChargingCycle(old, new SimulatorChargerAdapter(old));
    assert.equal(
      (
        await old.query("SELECT status FROM charging_sessions WHERE id=$1", [
          sid,
        ])
      ).rows[0].status,
      "active",
    );
    assert.equal(await count("session_power_history"), 1);
  } finally {
    pool = original;
    await old.end();
    await admin.query(`DROP SCHEMA ${upgradeSchema} CASCADE`);
  }
});
test("D19: dynamic power preserves tariff/payment snapshot, caps prepaid Wh and settles/refunds exactly once", async () => {
  await enable();
  const b = await paid({ prepaid: 1000, tariff: 1999 }),
    s = await active(b);
  await active(await paid({ user: other, port: 1 }));
  const original = (
    await pool.query("SELECT * FROM payments WHERE id=$1", [b.paymentId])
  ).rows[0];
  await tick(s);
  await scenario("deep_deficit");
  await dispatch();
  assert.equal(Number((await state(s)).acknowledged_w), 10000);
  let value = await current(s);
  for (let i = 0; i < 25 && value.status !== "completed"; i++) {
    await pool.query(
      "UPDATE simulator_session_state SET last_tick_at=clock_timestamp()-interval '10 seconds' WHERE session_id=$1",
      [s.id],
    );
    await cycle();
    value = await current(s);
    assert(value.energyWh <= value.energyBudgetWh);
  }
  assert.equal(value.status, "completed");
  assert.equal(value.stopReason, "prepayment_budget");
  assert.equal(
    value.settlement.finalCostKopecks,
    Math.ceil((value.energyWh * 1999) / 1000),
  );
  assert.equal(
    value.refund.amountKopecks,
    1000 - value.settlement.finalCostKopecks,
  );
  assert.equal(value.refund.status, "succeeded");
  await cycle();
  assert.equal(await count("session_settlements"), 1);
  assert.equal(await count("test_session_refund_receipts"), 1);
  assert.deepEqual(
    (await pool.query("SELECT * FROM payments WHERE id=$1", [b.paymentId]))
      .rows[0],
    original,
  );
});
