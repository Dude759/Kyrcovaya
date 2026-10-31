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
    "TRUNCATE grid_states,grid_samples,grid_requests,grid_actions CASCADE",
  );
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
  maxMin,
  gridBudget,
  SimulatorGridAdapter,
  type Demand,
} from "../src/modules/operator/grid-engine.js";
import { runGridCycle } from "../src/modules/operator/grid.js";
const d = (w: number, i: number, station = "s", limit = 1000000): Demand => ({
  id: String(i),
  stationId: station,
  requestedW: w,
  portLimitW: w,
  stationLimitW: limit,
});
const gridOp = (path: string, body?: any, key = randomUUID(), who = operator) =>
  request(
    "/api/operator/" + path,
    body ? "POST" : "GET",
    body,
    tokens[who],
    body ? key : undefined,
  );
test("G00: control 100/80/60/50 kW yields four equal 37500W", () => {
  assert.deepEqual(
    maxMin(
      [100000, 80000, 60000, 50000].map((w, i) => d(w, i)),
      150000,
    ).map((x) => x.plannedW),
    [37500, 37500, 37500, 37500],
  );
});
test("G01: small demand saturation redistributes remaining budget", () => {
  assert.deepEqual(
    maxMin([d(10000, 0), d(100000, 1), d(100000, 2)], 90000).map(
      (x) => x.plannedW,
    ),
    [10000, 40000, 40000],
  );
});
test("G02: station bottleneck redistributes to other stations", () => {
  assert.deepEqual(
    maxMin(
      [d(100000, 0, "a", 20000), d(100000, 1, "a", 20000), d(100000, 2, "b")],
      100000,
    ).map((x) => x.plannedW),
    [10000, 10000, 80000],
  );
});
test("G03: watt rounding is deterministic under every reversed input and never overspends", () => {
  for (let b = 0; b < 200; b++) {
    const rows = [d(100, 3), d(17, 1), d(83, 2)];
    const a = maxMin(rows, b);
    assert.deepEqual(a, maxMin([...rows].reverse(), b));
    assert(a.reduce((n, x) => n + x.plannedW, 0) <= b);
    assert(a.every((x) => x.plannedW <= x.requestedW));
  }
});
test("G04: zero budget, port cap and duplicate/invalid inputs", () => {
  assert.equal(maxMin([d(100, 1)], 0)[0].plannedW, 0);
  assert.equal(maxMin([{ ...d(100, 1), portLimitW: 20 }], 100)[0].plannedW, 20);
  assert.throws(() => maxMin([d(1, 1), d(2, 1)], 1));
  assert.throws(() => maxMin([d(-1, 1)], 1));
  assert.throws(() => maxMin([d(1, 1)], 1.1));
});
test("G05: formula uses whole W, clamps negative surplus and operator limit", () => {
  const a = new SimulatorGridAdapter(),
    now = new Date();
  assert.equal(
    gridBudget(a.read("normal", now, 60), 100000, now, 60).budgetW,
    100000,
  );
  assert.equal(
    gridBudget({ ...a.read("normal", now, 60), baseLoadKw: 600 }, 1e6, now, 60)
      .budgetW,
    0,
  );
});
test("G06: threshold boundary, stale/offline/missing/future/invalid never produce a budget", () => {
  const a = new SimulatorGridAdapter(),
    now = new Date();
  for (const scenario of ["stale", "offline", "missing"] as const)
    assert.equal(
      gridBudget(a.read(scenario, now, 60), 1e6, now, 60).budgetW,
      null,
    );
  const r = a.read("normal", now, 60);
  assert.equal(
    gridBudget(r, 1e6, new Date(now.getTime() + 60000), 60).validity,
    "fresh",
  );
  assert.equal(
    gridBudget(r, 1e6, new Date(now.getTime() + 60001), 60).validity,
    "stale",
  );
  assert.equal(
    gridBudget({ ...r, availablePowerKw: -1 }, 1e6, now, 60).validity,
    "invalid",
  );
  assert.equal(
    gridBudget(r, 1e6, new Date(now.getTime() - 1), 60).validity,
    "invalid",
  );
  assert.throws(() => gridBudget(r, 1e6, now, 0));
});
test("G07: 009 migration repeats; initially Grid is genuinely missing", async () => {
  await migrate(pool);
  assert.equal(await count("schema_migrations"), 10);
  const r = await gridOp("grid");
  assert.equal(r.data.budgetW, null);
  assert.equal(r.data.scenario, "missing");
  assert.equal((await gridOp("power/plan")).data.plan, null);
});
test("G08: scenario suite persists immutable inputs/results, including unavailable assignments", async () => {
  for (const scenario of [
    "normal",
    "deficit",
    "deep_deficit",
    "recovery",
    "offline",
    "stale",
    "missing",
  ]) {
    const r = await gridOp("grid/scenario", { scenario, workload: "training" });
    assert.equal(r.status, 200);
    const values = r.data.plan.assignments.map((x: any) => x.plannedW);
    assert.deepEqual(
      values,
      scenario === "deficit"
        ? [37500, 37500, 37500, 37500]
        : scenario === "deep_deficit"
          ? [5000, 5000, 5000, 5000]
          : scenario === "normal" || scenario === "recovery"
            ? [100000, 80000, 60000, 50000]
            : [null, null, null, null],
    );
    assert(
      r.data.plan.assignments.every(
        (x: any) => x.acknowledgedW === null && x.measuredW === null,
      ),
    );
  }
  assert.equal(await count("grid_actions"), 7);
  assert.equal(await count("power_plan_runs"), 7);
  await assert.rejects(
    pool.query("UPDATE grid_samples SET budget_w=0"),
    (e: any) => e.code === "23514",
  );
  await assert.rejects(
    pool.query("DELETE FROM power_plan_assignments"),
    (e: any) => e.code === "23514",
  );
});
test("G09: parallel same key replays once; changed payload 409 and unknown JSON rejected", async () => {
  const key = randomUUID(),
    body = { scenario: "deficit", workload: "training" };
  const [a, b] = await Promise.all([
    gridOp("grid/scenario", body, key),
    gridOp("grid/scenario", body, key),
  ]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.data, b.data);
  assert.equal(await count("grid_actions"), 1);
  assert.equal(
    (await gridOp("grid/scenario", { scenario: "normal" }, key)).status,
    409,
  );
  for (const input of [
    { scenario: "normal", organizationId: "fake" },
    { scenario: "fake" },
    { scenario: "normal", availablePowerKw: 1000 },
    { scenario: "normal", operatorLimitW: 999 },
  ])
    assert.equal((await gridOp("grid/scenario", input)).status, 400);
});
test("G10: role scope and independent organization budgets/history", async () => {
  assert.equal((await request("/api/operator/grid")).status, 403);
  await gridOp("grid/scenario", { scenario: "deficit", workload: "training" });
  const r = await gridOp("grid", undefined, undefined, foreignOperator);
  assert.equal(r.data.budgetW, null);
  const f = await gridOp(
    "grid/scenario",
    { scenario: "normal", workload: "training" },
    randomUUID(),
    foreignOperator,
  );
  assert.equal(f.data.grid.budgetW, 100000);
  assert.equal((await gridOp("grid")).data.budgetW, 150000);
  const history = await gridOp("grid/history?limit=1");
  assert.equal(history.data.items.length, 1);
  assert.equal(
    (await gridOp("grid/history?organizationId=anything")).status,
    400,
  );
});
test("G11: planning live load never changes session power, readings, reservations or settlement", async () => {
  const s = await active();
  await tick(s);
  const tables = [
    "charging_sessions",
    "session_measurements",
    "connector_reservations",
    "bookings",
    "payments",
    "session_settlements",
  ];
  const snapshot = async () =>
    Promise.all(
      tables.map(
        async (t) =>
          (
            await pool.query(
              `SELECT jsonb_agg(to_jsonb(x) ORDER BY id) AS data FROM ${t} x`,
            )
          ).rows[0].data,
      ),
    );
  const before = await snapshot();
  for (const scenario of ["normal", "deep_deficit", "offline"]) {
    const r = await gridOp("grid/scenario", { scenario, workload: "live" });
    assert.equal(r.status, 200);
    assert.equal(r.data.plan.assignments[0].currentAllocatedW, 22000);
    assert.equal(r.data.plan.assignments[0].acknowledgedW, null);
  }
  assert.deepEqual(await snapshot(), before);
  await runGridCycle(pool);
  assert.deepEqual(await snapshot(), before);
});
test("G12: actual server restart preserves configured scenario, history and sealed assignment rows", async () => {
  const first = await gridOp("grid/scenario", {
    scenario: "deficit",
    workload: "training",
  });
  const { child, address } = await processServer();
  try {
    const auth = await fetch(address + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "operator@energotransport.test",
        password,
        role: "operator",
      }),
    });
    const token = ((await auth.json()) as any).token;
    const response = await fetch(address + "/api/operator/power/plan", {
      headers: { Authorization: "Bearer " + token },
    });
    const r = (await response.json()) as any;
    assert.equal(r.grid.scenario, "deficit");
    assert.deepEqual(
      r.plan.assignments.map((x: any) => x.plannedW),
      [37500, 37500, 37500, 37500],
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO power_plan_assignments SELECT run_id,organization_id,'extra',station_key,requested_w,port_limit_w,station_limit_w,planned_w,acknowledged_w,measured_w,current_allocated_w FROM power_plan_assignments WHERE run_id=$1 LIMIT 1",
        [first.data.plan.id],
      ),
      (e: any) => e.code === "23514",
    );
  } finally {
    await stopProcess(child);
  }
});
