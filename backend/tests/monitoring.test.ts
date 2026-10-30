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
  await pool.query("TRUNCATE power_measurements");
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

import {
  aggregateHours,
  buildPowerHistory,
  HOUR,
} from "../src/modules/operator/aggregation.js";
import {
  monitoredSession,
  monitoredSelect,
} from "../src/modules/operator/monitoring.js";
const op = (path: string) =>
  request("/api/operator/" + path, "GET", undefined, tokens[operator]);

test("M00: 008 repeats and history uses the new table only", async () => {
  await migrate(pool);
  assert.equal(await count("schema_migrations"), 8);
  assert.equal(await count("power_measurements"), 0);
});
test("M01: no samples is unknown, not zero measured power or grid budget", async () => {
  const r = await op("monitoring");
  assert.equal(r.status, 200);
  assert.equal(r.data.source, "simulator");
  assert.equal(r.data.gridBudgetKw, null);
  assert.equal(r.data.measuredPowerW, null);
  assert.equal(r.data.measuredSubsetPowerW, null);
  assert.equal(r.data.knownEnergyWh, null);
  assert.equal(r.data.completedTestCostKopecks, 0);
});
test("M02: pending start reserves power without claiming any measurement", async () => {
  const s = await start(await paid());
  const r = (await op("monitoring")).data;
  assert.equal(r.sessionCounts.starting, 1);
  assert.equal(r.sessionCounts.active, 0);
  assert.equal(r.allocatedPowerW, 22000);
  assert.equal(r.measuredPowerW, null);
  assert.equal(r.sessions[0].knownEnergyWh, null);
  assert.equal(r.sessions[0].telemetry, "missing");
  assert(!("userId" in r.sessions[0]));
});
test("M03: current power and energy come exactly from latest simulator reading", async () => {
  const s = await active();
  await tick(s);
  const r = (await op("monitoring")).data;
  const m = (
    await pool.query(
      "SELECT * FROM session_measurements WHERE session_id=$1 ORDER BY sequence_no DESC LIMIT 1",
      [s.id],
    )
  ).rows[0];
  assert.equal(r.measuredPowerW, Number(m.power_w));
  assert.equal(r.knownEnergyWh, Number(m.energy_wh));
  assert(r.knownEnergyWh > 0);
  assert.equal(r.sessions[0].lastMeasuredAt, m.sampled_at.toISOString());
  assert.equal(r.sessions[0].telemetry, "fresh");
});
test("M04: exact 60-second freshness boundary, future sample and confirmed lost connection", async () => {
  const s = await active();
  const row = (await pool.query(monitoredSelect + " WHERE s.id=$1", [s.id]))
    .rows[0];
  assert.equal(
    monitoredSession(row, new Date(row.sampled_at.getTime() + 60000)).telemetry,
    "fresh",
  );
  assert.equal(
    monitoredSession(row, new Date(row.sampled_at.getTime() + 60001)).telemetry,
    "stale",
  );
  assert.equal(
    monitoredSession(row, new Date(row.sampled_at.getTime() + 60001))
      .currentPowerW,
    null,
  );
  assert.equal(
    monitoredSession(row, new Date(row.sampled_at.getTime() - 1)).currentPowerW,
    null,
  );
  await pool.query(
    "UPDATE simulator_devices SET online=false WHERE connector_id=$1",
    [s.connectorId],
  );
  assert.equal((await op("monitoring")).data.sessions[0].telemetry, "offline");
});
test("M05: simulator restart marks a gap and never invents energy for downtime", async () => {
  const s = await active();
  const energy = (await current(s)).energyWh;
  await pool.query(
    "UPDATE simulator_session_state SET last_tick_at=clock_timestamp()-interval '90 seconds' WHERE session_id=$1",
    [s.id],
  );
  adapter = new SimulatorChargerAdapter(pool);
  await cycle();
  const r = (await op("monitoring")).data;
  assert.equal(r.knownEnergyWh, energy);
  assert.equal(r.sessions[0].gap, true);
  assert.equal(r.sessions[0].telemetryGap, true);
});
test("M06: allocated power is never substituted for measured power", async () => {
  const s = await active();
  await pool.query(
    "UPDATE stations SET operating_state='service' WHERE id='tverskaya-plaza'",
  );
  await pool.query(
    "UPDATE simulator_session_state SET last_tick_at=clock_timestamp()-interval '10 seconds' WHERE session_id=$1",
    [s.id],
  );
  await adapter.sample(s.id);
  const r = (await op("monitoring")).data;
  assert.equal(r.allocatedPowerW, 22000);
  assert.equal(r.measuredPowerW, 0);
  assert.notEqual(r.allocatedPowerW, r.measuredPowerW);
});
test("M07: concurrent sessions with one offline expose only a measured subset", async () => {
  await active(await paid({ port: 0 }));
  const s = await active(await paid({ user: other, port: 1 }));
  await pool.query(
    "UPDATE simulator_devices SET online=false WHERE connector_id=$1",
    [s.connectorId],
  );
  const r = (await op("monitoring")).data;
  assert.equal(r.sessionCounts.active, 2);
  assert.equal(r.expectedSessions, 2);
  assert.equal(r.measuredSessions, 1);
  assert.equal(r.measuredSubsetPowerW, 22000);
  assert.equal(r.measuredPowerW, null);
  assert.equal(r.complete, false);
  assert.equal(r.allocatedPowerW, 44000);
});
const t0 = new Date("2026-01-01T00:00:00Z");
const stationFixture = [
  { id: "s", organization_id: "org", created_at: t0, limit_kw: 100 },
];
function reading(
  second: number,
  energy: number,
  sequence: number,
  gap = false,
) {
  return {
    station_id: "s",
    session_id: "session",
    sampled_at: new Date(t0.getTime() + second * 1000),
    energy_wh: energy,
    sequence_no: sequence,
    gap,
  };
}
test("M08: exact UTC boundary endpoints give a reproducible complete hour", () => {
  const readings = Array.from({ length: 361 }, (_, i) =>
    reading(i * 10, Math.floor((i * 22000) / 360), i),
  );
  const [r] = aggregateHours(
    stationFixture,
    [
      {
        station_id: "s",
        started_at: t0,
        ended_at: new Date(t0.getTime() + HOUR),
      },
    ],
    readings,
    t0,
    new Date(t0.getTime() + HOUR),
  );
  assert.equal(r.quality, "complete");
  assert.equal(r.measured_energy_wh, 22000);
  assert.equal(r.average_power_w, 22000);
  assert.equal(r.observed_ms, HOUR);
  assert.equal(r.boundary_count, 0);
});
test("M09: crossing an hour is not interpolated; boundary energy stays unattributed", () => {
  const rows = aggregateHours(
    stationFixture,
    [],
    [reading(3595, 0, 0), reading(3605, 61, 1), reading(3615, 122, 2)],
    t0,
    new Date(t0.getTime() + 2 * HOUR),
  );
  assert.equal(rows[0].measured_energy_wh, null);
  assert.equal(rows[1].measured_energy_wh, 61);
  assert.equal(rows[1].unattributed_energy_wh, 61);
  assert.equal(rows[1].boundary_count, 1);
  assert.equal(rows[1].average_power_w, null);
  assert.equal(rows[1].quality, "partial");
});
test("M10: gaps and unsampled hours stay partial/missing and never become zero energy", () => {
  const r = aggregateHours(
    stationFixture,
    [],
    [reading(0, 0, 0), reading(10, 60, 1), reading(100, 60, 2, true)],
    t0,
    new Date(t0.getTime() + 2 * HOUR),
  );
  assert.equal(r[0].observed_ms, 10000);
  assert.equal(r[0].measured_energy_wh, 60);
  assert.equal(r[0].gap_count, 1);
  assert.equal(r[0].quality, "partial");
  assert.equal(r[1].quality, "missing");
  assert.equal(r[1].measured_energy_wh, null);
  assert.equal(r[1].average_power_w, null);
});
test("M11: real PG history upsert and concurrent rebuild preserve rows and historical limit", async () => {
  const s = await active();
  await delay(10020);
  await cycle();
  const asOf = (await pool.query("SELECT clock_timestamp() AS now")).rows[0]
    .now;
  const range = {
    from: new Date(Math.floor(asOf.getTime() / HOUR) * HOUR),
    to: asOf,
  };
  await buildPowerHistory(pool, range);
  const before = (
    await pool.query(
      "SELECT * FROM power_measurements ORDER BY station_id,interval_start",
    )
  ).rows;
  assert(before.length >= 8);
  const measured = before.find((r) => r.station_id === "tverskaya-plaza");
  assert(measured.sample_count > 0);
  assert.equal(measured.quality, "partial");
  assert.equal(measured.average_power_w, null);
  await Promise.all([
    buildPowerHistory(pool, range),
    buildPowerHistory(pool, range),
  ]);
  const after = (
    await pool.query(
      "SELECT * FROM power_measurements ORDER BY station_id,interval_start",
    )
  ).rows;
  assert.deepEqual(after, before);
  const r = await request(
    "/api/operator/stations/tverskaya-plaza",
    "PATCH",
    { limitKw: 400 },
    tokens[operator],
  );
  assert.equal(r.status, 200);
  await buildPowerHistory(pool, range);
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT local_limit_kw FROM power_measurements WHERE station_id='tverskaya-plaza' ORDER BY interval_start DESC LIMIT 1",
        )
      ).rows[0].local_limit_kw,
    ),
    Number(measured.local_limit_kw),
  );
});
test("M12: confirmed stop and exact final kopecks are read from settlement", async () => {
  const s = await active();
  await tick(s);
  await finish(s);
  const settlement = (
    await pool.query("SELECT * FROM session_settlements WHERE session_id=$1", [
      s.id,
    ])
  ).rows[0];
  const r = (await op("monitoring")).data;
  assert.equal(r.sessionCounts.completed, 1);
  assert.equal(r.sessionCounts.stopping, 0);
  assert.equal(
    r.completedTestCostKopecks,
    Number(settlement.final_cost_kopecks),
  );
  const items = (await op("sessions?status=completed")).data.items;
  assert.equal(
    items[0].finalCostKopecks,
    Number(settlement.final_cost_kopecks),
  );
  assert.equal(items[0].currentPowerW, null);
  assert(!("email" in items[0]));
});
test("M13: history/session filters, pagination, strict queries and organization isolation", async () => {
  await active(await paid({ port: 0 }));
  await active(await paid({ user: other, port: 1 }));
  await buildPowerHistory(pool);
  const page = (await op("sessions?status=active&limit=1")).data;
  assert.equal(page.items.length, 1);
  assert(page.nextCursor);
  const next = (
    await op("sessions?status=active&limit=1&cursor=" + page.nextCursor)
  ).data;
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0].id, page.items[0].id);
  const h = (await op("monitoring/history?limit=1&quality=partial")).data;
  assert(h.items.length);
  if (h.nextCursor)
    assert.notDeepEqual(
      (
        await op(
          "monitoring/history?limit=1&quality=partial&cursor=" + h.nextCursor,
        )
      ).data.items,
      h.items,
    );
  for (const path of [
    "monitoring",
    "sessions",
    "monitoring/history",
    "monitoring/events",
    "monitoring/stations/tverskaya-plaza",
  ])
    assert.equal((await request("/api/operator/" + path)).status, 403);
  for (const path of [
    "monitoring/stations/tverskaya-plaza",
    "sessions?stationId=tverskaya-plaza",
    "monitoring/history?stationId=tverskaya-plaza",
    "monitoring/events?stationId=tverskaya-plaza",
  ])
    assert.equal(
      (
        await request(
          "/api/operator/" + path,
          "GET",
          undefined,
          tokens[foreignOperator],
        )
      ).status,
      404,
    );
  assert.equal(
    (
      await request(
        "/api/operator/monitoring",
        "GET",
        undefined,
        tokens[foreignOperator],
      )
    ).data.sessions.length,
    0,
  );
  for (const query of [
    "limit=101",
    "organizationId=stolen",
    "cursor=invalid",
    "quality=madeup",
    "from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z",
  ])
    assert.equal((await op("monitoring/history?" + query)).status, 400);
});
test("M14: pending/acknowledged technical command states never pollute immutable operator audit", async () => {
  const baseline = await count("network_events");
  const s = await start(await paid());
  assert.equal((await op("monitoring/events")).data.items[0].status, "pending");
  await cycle();
  await stopSession(pool, driver, s.id, randomUUID());
  assert.equal((await op("monitoring")).data.sessionCounts.stopping, 1);
  const events = (await op("monitoring/events")).data.items;
  assert(events.some((e: any) => e.kind === "stop" && e.status === "pending"));
  assert(
    events.some((e: any) => e.kind === "start" && e.status === "acknowledged"),
  );
  assert.equal(await count("network_events"), baseline);
});
test("M15: real OS restart preserves history, session and exact settlement after new login", async () => {
  const s = await active();
  await tick(s);
  await finish(s);
  await buildPowerHistory(pool);
  const n = await count("power_measurements");
  const { child, address } = await processServer();
  try {
    const login = await fetch(address + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "operator@energotransport.test",
        password,
        role: "operator",
      }),
    });
    const token = ((await login.json()) as any).token;
    const response = await fetch(
      address + "/api/operator/sessions?status=completed",
      { headers: { Authorization: "Bearer " + token } },
    );
    const data = (await response.json()) as any;
    assert.equal(data.items[0].id, s.id);
    assert(data.items[0].finalCostKopecks > 0);
    await delay(200);
    assert.equal(await count("power_measurements"), n);
  } finally {
    await stopProcess(child);
  }
});
test("M16: one fully measured concurrent session cannot conceal an entirely unmeasured session", () => {
  const readings = Array.from({ length: 361 }, (_, i) =>
    reading(i * 10, Math.floor((i * 22000) / 360), i),
  );
  const expected = [0, 1].map(() => ({
    station_id: "s",
    started_at: t0,
    ended_at: new Date(t0.getTime() + HOUR),
  }));
  const [r] = aggregateHours(
    stationFixture,
    expected,
    readings,
    t0,
    new Date(t0.getTime() + HOUR),
  );
  assert.equal(r.observed_ms, HOUR);
  assert.equal(r.expected_session_ms, 2 * HOUR);
  assert.equal(r.quality, "partial");
  assert.equal(r.average_power_w, null);
});
test("M17: station history constraints reject inconsistent organization and fake complete coverage", async () => {
  await buildPowerHistory(pool);
  const row = (await pool.query("SELECT * FROM power_measurements LIMIT 1"))
    .rows[0];
  const foreign = (
    await pool.query(
      "SELECT organization_id FROM users WHERE email_normalized='foreign.operator@fixture.test'",
    )
  ).rows[0].organization_id;
  await assert.rejects(
    pool.query(
      "UPDATE power_measurements SET organization_id=$1 WHERE station_id=$2",
      [foreign, row.station_id],
    ),
    (e: any) => e.code === "23503",
  );
  await assert.rejects(
    pool.query(
      "UPDATE power_measurements SET quality='complete',average_power_w=0 WHERE station_id=$1",
      [row.station_id],
    ),
    (e: any) => e.code === "23514",
  );
});
