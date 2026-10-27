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

test("C00: migration 005 repeats; start/stop reject client telemetry and missing idempotency keys", async () => {
  await migrate(pool);
  assert.equal(await count("schema_migrations"), 6);
  const b = await paid();
  assert.equal(
    (await request("/api/sessions", "POST", { bookingId: b.id })).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/sessions",
        "POST",
        { bookingId: b.id, energy: 1 },
        tokens[driver],
        randomUUID(),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/sessions",
        "POST",
        { bookingId: b.id },
        tokens[operator],
        randomUUID(),
      )
    ).status,
    403,
  );
  assert.equal(await count("charging_sessions"), 0);
});
test("C01: only owner can start paid confirmed booking; immutable physical and tariff snapshot", async () => {
  const b = await paid();
  await assert.rejects(startSession(pool, other, b.id, randomUUID()), {
    status: 404,
  });
  const s = await start(b);
  assert.equal(s.status, "starting");
  assert.equal(s.startConfirmedAt, null);
  assert.equal(s.soc, null);
  assert.equal(s.source, "simulator");
  assert.equal(s.connectorId, b.connectorId);
  assert.equal(s.tariffKopecks, 1800);
  await assert.rejects(
    pool.query("UPDATE charging_sessions SET tariff_kopecks=1 WHERE id=$1", [
      s.id,
    ]),
    { code: "23514" },
  );
});
test("C02: explicit start window rejects early and late starts without creating commands", async () => {
  const early = await paid({ offset: 60000 });
  await assert.rejects(start(early), { status: 409 });
  const late = await paid({ offset: -16 * 60000, port: 1 });
  await assert.rejects(start(late), { status: 409 });
  assert.equal(await count("charging_commands"), 0);
});
test("C03: parallel starts, same or different keys, create one session and one durable start command", async () => {
  const b = await paid(),
    key = randomUUID();
  const sessions = await Promise.all([start(b, key), start(b, key), start(b)]);
  assert(sessions.every((s) => s.id === sessions[0].id));
  assert.equal(await count("charging_sessions"), 1);
  assert.equal(await count("charging_commands"), 1);
  assert.equal(await count("charging_command_requests"), 2);
});
test("C04: one driver cannot charge two ports concurrently; station power reservation is bounded", async () => {
  const first = await paid(),
    second = await paid({ port: 1 });
  const s = await active(first);
  await assert.rejects(start(second), { status: 409 });
  await pool.query("UPDATE stations SET limit_kw=10 WHERE id=$1", [
    "tverskaya-plaza",
  ]);
  const otherBooking = await paid({ user: other, port: 2 });
  await assert.rejects(start(otherBooking), { status: 409 });
  assert.equal(await count("charging_sessions"), 1);
  assert.equal((await current(s)).status, "active");
});
test("C05: starting is not active until simulator acknowledgement; delayed command persists", async () => {
  const b = await paid();
  await pool.query(
    "UPDATE simulator_devices SET command_delay_ms=300 WHERE connector_id=$1",
    [b.connectorId],
  );
  const s = await start(b);
  await cycle();
  assert.equal((await current(s)).status, "starting");
  assert.equal(await count("simulator_command_receipts"), 0);
  await delay(320);
  await cycle();
  assert.equal((await current(s)).status, "active");
  assert.equal(await count("simulator_command_receipts"), 1);
});
test("C06: explicit simulator start rejection yields failed session, zero settlement and full test refund", async () => {
  const b = await paid();
  await pool.query(
    "UPDATE simulator_devices SET reject_start=true WHERE connector_id=$1",
    [b.connectorId],
  );
  const s = await start(b);
  await cycle();
  const r = await current(s);
  assert.equal(r.status, "failed");
  assert.equal(r.energyWh, 0);
  assert.equal(r.settlement.finalCostKopecks, 0);
  assert.equal(r.refund.status, "succeeded");
  assert.equal(r.refund.amountKopecks, 10000);
});
test("C07: metering is monotone and repeated sequence is idempotent only for identical data", async () => {
  const s = await active();
  const a = await tick(s),
    b = await tick(s);
  assert(a.energyWh > 0);
  assert(b.energyWh >= a.energyWh);
  assert.equal(b.telemetry!.source, "simulator");
  const m = (
    await pool.query(
      "SELECT * FROM session_measurements WHERE session_id=$1 ORDER BY sequence_no DESC LIMIT 1",
      [s.id],
    )
  ).rows[0];
  await pool.query(
    "INSERT INTO session_measurements(session_id,sequence_no,sampled_at,energy_wh,power_w,source,gap,final) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(session_id,sequence_no) DO NOTHING",
    [
      s.id,
      m.sequence_no,
      m.sampled_at,
      m.energy_wh,
      m.power_w,
      m.source,
      m.gap,
      m.final,
    ],
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO session_measurements(session_id,sequence_no,energy_wh,power_w) VALUES($1,$2,$3,0)",
      [s.id, m.sequence_no, Number(m.energy_wh) + 1],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO session_measurements(session_id,sequence_no,energy_wh,power_w) VALUES($1,$2,0,0)",
      [s.id, Number(m.sequence_no) + 1],
    ),
    { code: "23514" },
  );
});
test("C08: loss of communication preserves energy, hides power and resumes without gap backfill", async () => {
  const s = await active();
  const before = await tick(s);
  await pool.query(
    "UPDATE simulator_devices SET online=false WHERE connector_id=$1",
    [s.connectorId],
  );
  await pool.query(
    "UPDATE simulator_session_state SET last_tick_at=clock_timestamp()-interval '90 seconds' WHERE session_id=$1",
    [s.id],
  );
  await cycle();
  const offline = await current(s);
  assert.equal(offline.energyWh, before.energyWh);
  assert.equal(offline.currentPowerKw, null);
  assert.equal(offline.telemetry!.connection, "offline");
  await pool.query(
    "UPDATE simulator_devices SET online=true WHERE connector_id=$1",
    [s.connectorId],
  );
  await cycle();
  const resumed = await current(s);
  assert.equal(resumed.energyWh, before.energyWh);
  assert.equal(resumed.telemetryGap, true);
  assert.equal(resumed.telemetry!.connection, "online");
});
test("C09: stop while simulator offline remains stopping, never completed without final reading", async () => {
  const s = await active();
  await tick(s);
  await pool.query(
    "UPDATE simulator_devices SET online=false WHERE connector_id=$1",
    [s.connectorId],
  );
  await stopSession(pool, driver, s.id, randomUUID());
  await cycle();
  const pending = await current(s);
  assert.equal(pending.status, "stopping");
  assert.equal(pending.endedAt, null);
  assert.equal(pending.settlement, null);
  assert.equal(await count("session_refunds"), 0);
  await pool.query(
    "UPDATE simulator_devices SET online=true WHERE connector_id=$1",
    [s.connectorId],
  );
  await cycle();
  assert.equal((await current(s)).status, "completed");
});
test("C10: repeated and parallel stops share one command, settlement and refund receipt", async () => {
  const s = await active();
  await tick(s);
  const key = randomUUID();
  await Promise.all([
    stopSession(pool, driver, s.id, key),
    stopSession(pool, driver, s.id, key),
    stopSession(pool, driver, s.id, randomUUID()),
  ]);
  await cycle();
  const done = await current(s);
  assert.equal(done.status, "completed");
  assert.equal(await count("session_settlements"), 1);
  assert.equal(await count("test_session_refund_receipts"), 1);
  const repeated = await stopSession(pool, driver, s.id, randomUUID());
  assert.deepEqual(repeated.settlement, done.settlement);
  assert.equal(await count("charging_commands"), 2);
});
test("C11: profile and catalog tariff changes cannot change session metering budget or billed tariff", async () => {
  const b = await paid({ tariff: 1999 }),
    s = await active(b);
  await pool.query(
    "UPDATE driver_profiles SET battery_capacity_kwh=250 WHERE user_id=$1",
    [driver],
  );
  await pool.query(
    "UPDATE stations SET price_per_kwh_kopecks=99999 WHERE id='tverskaya-plaza'",
  );
  await tick(s);
  const result = await finish(s);
  assert.equal(result.batteryCapacity, 75);
  assert.equal(result.tariffKopecks, 1999);
  assert.equal(result.soc, null);
  assert.equal(
    result.settlement.finalCostKopecks,
    Math.ceil((result.energyWh * 1999) / 1000),
  );
  assert.equal(
    result.refund.amountKopecks,
    10000 - result.settlement.finalCostKopecks,
  );
});
test("C12: integer kopecks settle only measured Wh and terminal financial result is immutable", async () => {
  const s = await active();
  await tick(s);
  const result = await finish(s);
  assert(Number.isInteger(result.settlement.finalCostKopecks));
  assert.equal(
    result.settlement.unusedKopecks + result.settlement.finalCostKopecks,
    10000,
  );
  await assert.rejects(
    pool.query(
      "UPDATE session_settlements SET final_cost_kopecks=0 WHERE session_id=$1",
      [s.id],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query(
      "UPDATE charging_sessions SET energy_wh=energy_wh+1 WHERE id=$1",
      [s.id],
    ),
    { code: "23514" },
  );
});
test("C13: prepayment safety margin initiates stop and hard meter budget never allows debt", async () => {
  const s = await active(await paid({ prepaid: 1000 }));
  let result = await current(s);
  for (let i = 0; i < 20 && result.status === "active"; i++)
    result = await tick(s);
  assert.equal(result.status, "stopping");
  await cycle();
  const done = await current(s);
  assert.equal(done.status, "completed");
  assert.equal(done.stopReason, "prepayment_budget");
  assert(done.energyWh <= done.energyBudgetWh);
  assert(done.settlement.finalCostKopecks <= 1000);
});
test("C14: changed station limit stops simulator safely rather than silently exceeding new limit", async () => {
  const s = await active();
  await pool.query("UPDATE stations SET limit_kw=1 WHERE id='tverskaya-plaza'");
  await tick(s);
  assert.equal((await current(s)).status, "stopping");
  await cycle();
  const done = await current(s);
  assert.equal(done.status, "completed");
  assert.equal(done.stopReason, "local_limit");
});
test("C15: lost stop response keeps durable receipt; replay completes without a second final reading", async () => {
  const s = await active();
  await tick(s);
  await stopSession(pool, driver, s.id, randomUUID());
  const broken: ChargerAdapter = {
    sample: (id) => adapter.sample(id),
    execute: async (id) => {
      const r = await adapter.execute(id);
      if (r) throw new Error("Lost adapter reply");
      return r;
    },
  };
  await assert.rejects(runChargingCycle(pool, broken), /Lost adapter reply/);
  assert.equal((await current(s)).status, "stopping");
  assert.equal(await count("session_settlements"), 0);
  const n = await count("session_measurements");
  await cycle();
  assert.equal((await current(s)).status, "completed");
  assert.equal(await count("session_measurements"), n);
});
test("C16: refund adapter failure before receipt leaves submitted remainder, not a completed refund", async () => {
  const s = await active();
  await tick(s);
  await stopSession(pool, driver, s.id, randomUUID());
  await assert.rejects(
    runChargingCycle(pool, adapter, async () => {
      throw new Error("Refund offline");
    }),
    /Refund offline/,
  );
  const result = await current(s);
  assert.equal(result.status, "completed");
  assert.equal(result.refund.status, "submitted");
  assert.equal(result.refund.confirmedAt, null);
  assert.equal(await count("test_session_refund_receipts"), 0);
  await recoverSessionRefund(pool, result.refund.id);
  assert.equal((await current(s)).refund.status, "succeeded");
});
test("C17: crash after remainder receipt recovers using same refund ID and no double refund", async () => {
  const s = await active();
  await tick(s);
  await stopSession(pool, driver, s.id, randomUUID());
  await assert.rejects(
    runChargingCycle(pool, adapter, async (db, id) => {
      await confirmTestSessionRefund(db, id);
      throw new Error("Crash after receipt");
    }),
    /Crash after receipt/,
  );
  const r = await current(s);
  assert.equal(r.refund.status, "submitted");
  assert.equal(await count("test_session_refund_receipts"), 1);
  await recoverSessionRefund(pool, r.refund.id);
  await recoverSessionRefund(pool, r.refund.id);
  assert.equal((await current(s)).refund.status, "succeeded");
  assert.equal(await count("test_session_refund_receipts"), 1);
});
test("C18: combined compensation plus session remainder cannot refund more than paid", async () => {
  const b = await paid(),
    s = await active(b);
  await tick(s);
  await finish(s);
  await assert.rejects(
    pool.query(
      "INSERT INTO payment_compensations(payment_id,attempt_id,amount_kopecks,reason) VALUES($1,$2,10000,'extra_success')",
      [b.paymentId, b.attemptId],
    ),
    { code: "23514" },
  );
  assert.equal(await count("payment_compensations"), 0);
});
test("C19: owner and operator scopes isolate session details and workspace histories", async () => {
  const s = await active();
  await assert.rejects(current(s, other), { status: 404 });
  const opId = (
    await pool.query("SELECT organization_id FROM users WHERE id=$1", [
      operator,
    ])
  ).rows[0].organization_id;
  assert.equal(
    (
      await getSession(pool, s.id, {
        id: operator,
        role: "operator",
        organizationId: opId,
      })
    ).id,
    s.id,
  );
  assert.equal(
    (
      await request(
        "/api/sessions/" + s.id,
        "GET",
        undefined,
        tokens[foreignOperator],
      )
    ).status,
    404,
  );
  assert.equal(
    (await request("/api/workspace", "GET", undefined, tokens[foreignOperator]))
      .data.sessions.length,
    0,
  );
  assert.equal(
    (await request("/api/workspace", "GET", undefined, tokens[operator])).data
      .sessions.length,
    1,
  );
  assert.equal(
    (
      await request(
        "/api/sessions/" + s.id + "/stop",
        "POST",
        {},
        tokens[operator],
        randomUUID(),
      )
    ).status,
    403,
  );
});
test("C20: idempotency key cannot be reused for another booking or command payload", async () => {
  const b = await paid(),
    key = randomUUID();
  const s = await start(b, key);
  const another = await paid({ port: 1 });
  await assert.rejects(start(another, key), { status: 409 });
  await assert.rejects(stopSession(pool, driver, s.id, key), { status: 409 });
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
test("C21: real API process restart preserves active session and never backfills 90 seconds of energy", async () => {
  const s = await active(),
    before = await tick(s);
  await pool.query(
    "UPDATE simulator_session_state SET last_tick_at=clock_timestamp()-interval '90 seconds' WHERE session_id=$1",
    [s.id],
  );
  const child = await processServer();
  try {
    for (let i = 0; i < 30; i++) {
      if ((await current(s)).telemetryGap) break;
      await delay(100);
    }
    const result = await current(s);
    assert.equal(result.status, "active");
    assert.equal(result.energyWh, before.energyWh);
    assert.equal(result.telemetryGap, true);
    assert.equal(await count("charging_sessions"), 1);
    const r = await fetch(child.address + "/api/sessions/" + s.id + "/stop", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens[driver]}`,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: "{}",
    });
    assert.equal(r.status, 202);
    for (let i = 0; i < 30; i++) {
      if ((await current(s)).status === "completed") break;
      await delay(100);
    }
    assert.equal((await current(s)).status, "completed");
  } finally {
    await stopProcess(child.child);
  }
});
test("C22: stop before delayed start is acknowledged never claims the device charged", async () => {
  const b = await paid();
  const s = await start(b);
  await stopSession(pool, driver, s.id, randomUUID());
  await cycle();
  const result = await current(s);
  assert.equal(result.status, "completed");
  assert.equal(result.startConfirmedAt, null);
  assert.equal(result.energyWh, 0);
  assert.equal(result.refund.amountKopecks, 10000);
});
async function historicalActive(b: any) {
  return transaction(pool, async (db) => {
    const s = (
      await db.query(
        `INSERT INTO charging_sessions(booking_id,payment_id,funding_attempt_id,user_id,organization_id,station_id,connector_id,connector_type,window_start,window_end,prepaid_kopecks,tariff_kopecks,energy_budget_wh,allocated_power_w,battery_capacity_kwh,requested_at)
    SELECT b.id,p.id,b.payment_attempt_id,b.user_id,b.organization_id,b.station_id,b.connector_id,b.connector_type,b.start_at,b.end_at,p.amount_kopecks,p.quoted_tariff_kopecks,p.amount_kopecks*1000/p.quoted_tariff_kopecks,22000,75,b.start_at
    FROM bookings b JOIN payments p ON p.id=b.payment_id WHERE b.id=$1 RETURNING *`,
        [b.id],
      )
    ).rows[0];
    const sampled = new Date(b.start.getTime() + 10000);
    await db.query(
      "INSERT INTO simulator_session_state(session_id,state,energy_wh,sequence_no,last_tick_at,epoch) VALUES($1,'charging',37,0,$2,$3)",
      [s.id, sampled, adapter.epoch],
    );
    const m = (
      await db.query(
        "INSERT INTO session_measurements(session_id,sequence_no,sampled_at,energy_wh,power_w) VALUES($1,0,$2,37,22000) RETURNING id",
        [s.id, sampled],
      )
    ).rows[0];
    const c = (
      await db.query(
        "INSERT INTO charging_commands(session_id,kind,status,created_at,ready_at,confirmed_at) VALUES($1,'start','acknowledged',$2,$2,$2) RETURNING id",
        [s.id, b.start],
      )
    ).rows[0];
    await db.query(
      "INSERT INTO simulator_command_receipts(command_id,session_id,accepted,confirmed_at,measurement_id) VALUES($1,$2,true,$3,$4)",
      [c.id, s.id, b.start, m.id],
    );
    await db.query("UPDATE bookings SET status='used' WHERE id=$1", [b.id]);
    return (
      await db.query(
        "UPDATE charging_sessions SET status='active',started_at=$2,energy_wh=37,last_sequence=0,measured_at=$3 WHERE id=$1 RETURNING *",
        [s.id, b.start, sampled],
      )
    ).rows[0];
  });
}
test("C23: real stored readings older than 60 seconds are stale; last energy stays and current power is null", async () => {
  const s = await historicalActive(await paid({ offset: -120000 })),
    r = await current(s);
  assert.equal(r.telemetry.connection, "stale");
  assert.equal(r.energyWh, 37);
  assert.equal(r.currentPowerKw, null);
  assert.equal(r.soc, null);
});
test("C24: another driver cannot use a physical port occupied by an unfinished overdue session", async () => {
  const first = await paid({ offset: -30 * 60000 - 1000 }),
    s = await historicalActive(first);
  await pool.query(
    "UPDATE simulator_devices SET online=false WHERE connector_id=$1",
    [first.connectorId],
  );
  const second = await paid({ user: other, startAt: first.end });
  await assert.rejects(start(second), { status: 409 });
  assert.equal(await count("charging_sessions"), 1);
  assert.equal((await current(s)).status, "active");
});
test("C25: rollback after stop acknowledgement cannot expose completed session or partial settlement", async () => {
  const s = await active();
  await tick(s);
  await stopSession(pool, driver, s.id, randomUUID());
  await pool.query(
    "CREATE FUNCTION fail_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='completed' THEN RAISE EXCEPTION 'Terminal rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_terminal BEFORE UPDATE ON charging_sessions FOR EACH ROW EXECUTE FUNCTION fail_terminal()",
  );
  try {
    await assert.rejects(cycle(), /Terminal rollback/);
  } finally {
    await pool.query(
      "DROP TRIGGER fail_terminal ON charging_sessions; DROP FUNCTION fail_terminal()",
    );
  }
  assert.equal((await current(s)).status, "stopping");
  assert.equal(await count("session_settlements"), 0);
  assert.equal(await count("session_refunds"), 0);
  await cycle();
  assert.equal((await current(s)).status, "completed");
  assert.equal(await count("session_settlements"), 1);
});
test("C26: fake refund confirmation without a durable adapter receipt never completes remainder refund", async () => {
  const s = await active();
  await tick(s);
  await stopSession(pool, driver, s.id, randomUUID());
  await assert.rejects(
    runChargingCycle(pool, adapter, async () => {
      throw new Error("Offline");
    }),
  );
  const r = await current(s),
    intent = (
      await pool.query("SELECT * FROM session_refunds WHERE id=$1", [
        r.refund.id,
      ])
    ).rows[0];
  await assert.rejects(
    recoverSessionRefund(pool, intent.id, async () => ({
      provider_refund_id: intent.provider_refund_id,
      amount_kopecks: intent.amount_kopecks,
      confirmed_at: new Date(),
    })),
    /Durable session refund receipt missing/,
  );
  assert.equal((await current(s)).refund.status, "submitted");
});
test("C27: reservation deadline automatically stops a historical active session without gap energy", async () => {
  const b = await paid({ offset: -30 * 60000 + 500 }),
    s = await historicalActive(b);
  await cycle();
  await delay(550);
  await cycle();
  await cycle();
  const r = await current(s);
  assert.equal(r.status, "completed");
  assert.equal(r.stopReason, "reservation_end");
  assert(r.energyWh <= 41);
  assert.equal(r.telemetryGap, true);
});
test("C28: parallel starts on separate ports reserve at most the common station limit", async () => {
  const first = await paid(),
    second = await paid({ user: other, port: 1 });
  await pool.query(
    "UPDATE stations SET limit_kw=30 WHERE id='tverskaya-plaza'",
  );
  const sessions = await Promise.all([start(first), start(second)]);
  const allocated = (
    await pool.query(
      "SELECT allocated_power_w FROM charging_sessions ORDER BY allocated_power_w",
    )
  ).rows.map((r) => Number(r.allocated_power_w));
  assert.deepEqual(allocated, [8000, 22000]);
  await cycle();
  assert.equal((await current(sessions[0])).status, "active");
  assert.equal((await current(sessions[1], other)).status, "active");
});
test("C29: parallel remainder recovery produces one receipt and cannot regress a confirmed refund", async () => {
  const s = await active();
  await tick(s);
  await stopSession(pool, driver, s.id, randomUUID());
  await assert.rejects(
    runChargingCycle(pool, adapter, async () => {
      throw new Error("Offline");
    }),
  );
  const id = (await current(s)).refund.id;
  await Promise.all([
    recoverSessionRefund(pool, id),
    recoverSessionRefund(pool, id),
  ]);
  assert.equal(await count("test_session_refund_receipts"), 1);
  assert.equal((await current(s)).refund.status, "succeeded");
  await assert.rejects(
    pool.query(
      "UPDATE session_refunds SET status='pending',confirmed_at=NULL WHERE id=$1",
      [id],
    ),
    { code: "23514" },
  );
});
test("C30: unavailable station or physical port never starts a simulator session", async () => {
  const b = await paid();
  await pool.query(
    "UPDATE connectors SET operating_state='service' WHERE id=$1",
    [b.connectorId],
  );
  await assert.rejects(start(b), { status: 409 });
  assert.equal(await count("charging_sessions"), 0);
});
test("C31: actual delayed device start must also fit the 15-minute start window", async () => {
  const b = await paid({ offset: -15 * 60000 + 1000 });
  await pool.query(
    "UPDATE simulator_devices SET command_delay_ms=1200 WHERE connector_id=$1",
    [b.connectorId],
  );
  const s = await start(b);
  await delay(1250);
  await cycle();
  const r = await current(s);
  assert.equal(r.status, "failed");
  assert.equal(r.energyWh, 0);
  assert.equal(r.refund.status, "succeeded");
});
