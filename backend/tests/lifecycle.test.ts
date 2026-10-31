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
test("L00: 006 repeats; snapshot, uncontrolled reservation release and early no-show are guarded", async () => {
  await migrate(pool);
  assert.equal(await count("schema_migrations"), 9);
  const b = await paid({ offset: 60000 });
  await assert.rejects(
    pool.query(
      "UPDATE bookings SET start_at=start_at+interval '1 minute' WHERE id=$1",
      [b.id],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query(
      "UPDATE connector_reservations SET state='released' WHERE booking_id=$1",
      [b.id],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    transaction(pool, async (db) => {
      await db.query(
        "INSERT INTO booking_closures(booking_id,reason) VALUES($1,'no_show')",
        [b.id],
      );
      await db.query("UPDATE bookings SET status='expired' WHERE id=$1", [
        b.id,
      ]);
      await db.query(
        "UPDATE connector_reservations SET state='expired' WHERE booking_id=$1",
        [b.id],
      );
      await db.query(
        "INSERT INTO booking_refunds(booking_id,payment_id,attempt_id,amount_kopecks) VALUES($1,$2,$3,10000)",
        [b.id, b.paymentId, b.attemptId],
      );
    }),
    { code: "23514" },
  );
});
test("L01: cancel atomically releases a paid booking and full refund waits for receipt", async () => {
  const b = await paid({ offset: 60000 });
  const c = await cancelBooking(pool, driver, b.id);
  assert.equal(c!.status, "cancelled");
  assert.equal(c!.closureReason, "driver");
  assert.equal(c!.refund!.status, "pending");
  assert.equal(c!.refund!.amountKopecks, 10000);
  assert.equal(await reservation(b), "released");
  assert.equal(await count("test_booking_refund_receipts"), 0);
  const v = await closed(b);
  assert.equal(v.refund!.status, "succeeded");
  assert(v.refund!.confirmedAt);
});
test("L02: repeated cancel preserves reason, timestamp and provider ID without another refund", async () => {
  const b = await paid();
  const a = await cancelBooking(pool, driver, b.id);
  const c = await cancelBooking(pool, driver, b.id);
  assert.deepEqual(c, a);
  await closed(b);
  await cancelBooking(pool, driver, b.id);
  await closed(b);
  assert.equal(await count("booking_refunds"), 1);
  assert.equal(await count("test_booking_refund_receipts"), 1);
});
test("L03: parallel cancellation requests commit exactly one closure/refund", async () => {
  const b = await paid();
  const values = await Promise.all(
    Array.from({ length: 4 }, () => cancelBooking(pool, driver, b.id)),
  );
  assert(values.every((v) => v!.refund!.id === values[0]!.refund!.id));
  assert.equal(await count("booking_closures"), 1);
});
test("L04: no-show boundary is half-open and PG time is rechecked AFTER waiting for locks", async () => {
  const clock = (await pool.query("SELECT clock_timestamp() now")).rows[0].now;
  const b = await paid({
    startAt: new Date(clock.getTime() - 15 * 60000 + 800),
  });
  const blocker = await pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM payments WHERE id=$1 FOR UPDATE", [
    b.paymentId,
  ]);
  try {
    const cancelled = cancelBooking(pool, driver, b.id);
    await delay(1000);
    await blocker.query("COMMIT");
    const v = await cancelled;
    assert.equal(v!.status, "expired");
    assert.equal(v!.closureReason, "no_show");
    assert.equal(await reservation(b), "expired");
    const d = (
      await pool.query(
        "SELECT booking_start_deadline(start_at,end_at) deadline FROM bookings WHERE id=$1",
        [b.id],
      )
    ).rows[0].deadline;
    assert(new Date(v!.closedAt!).getTime() >= d.getTime());
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});
test("L05: no-show recovery releases overdue confirmed booking and repeated calls preserve outcome", async () => {
  const b = await paid({ offset: -16 * 60000 });
  const a = await closed(b);
  assert.equal(a.status, "expired");
  assert.equal(a.refund!.status, "succeeded");
  const c = await cancelBooking(pool, driver, b.id);
  assert.equal(c!.closedAt, a.closedAt);
  assert.equal(await count("booking_refunds"), 1);
});
test("L06: concurrent start versus cancel has one winner and never releases an uncertain start", async () => {
  const b = await paid();
  const results = await Promise.allSettled([
    start(b),
    cancelBooking(pool, driver, b.id),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  if (await count("charging_sessions")) {
    assert.equal(await reservation(b), "confirmed");
    assert.equal(await count("booking_refunds"), 0);
    await cycle();
  } else {
    assert.equal(await reservation(b), "released");
    assert.equal(await count("charging_commands"), 0);
  }
});
test("L07: no-show workers cannot expire starting with a delayed or offline acknowledgement", async () => {
  const b = await paid({ offset: -15 * 60000 + 900 });
  await pool.query(
    "UPDATE simulator_devices SET online=false WHERE connector_id=$1",
    [b.connectorId],
  );
  const s = await start(b);
  await delay(1000);
  await recoverBookingLifecycle(pool);
  await assert.rejects(cancelBooking(pool, driver, b.id), { status: 409 });
  assert.equal((await current(s)).status, "starting");
  assert.equal(await reservation(b), "confirmed");
  assert.equal(await count("booking_refunds"), 0);
});
test("L08: failed session already has Stage3D refund; cancel never creates a second one", async () => {
  const b = await paid();
  await pool.query(
    "UPDATE simulator_devices SET reject_start=true WHERE connector_id=$1",
    [b.connectorId],
  );
  const s = await start(b);
  await cycle();
  assert.equal((await current(s)).status, "failed");
  await assert.rejects(cancelBooking(pool, driver, b.id), { status: 409 });
  await recoverBookingLifecycle(pool);
  assert.equal(await reservation(b), "released");
  assert.equal(await count("booking_refunds"), 0);
  assert.equal(await count("session_refunds"), 1);
});
test("L09: active, stopping and completed used bookings cannot be cancelled or expired", async () => {
  const b = await paid();
  const s = await active(b);
  for (const phase of ["active", "stopping", "completed"]) {
    if (phase === "stopping")
      await stopSession(pool, driver, s.id, randomUUID());
    if (phase === "completed") await cycle();
    await assert.rejects(cancelBooking(pool, driver, b.id), { status: 409 });
    await recoverBookingLifecycle(pool);
    assert.equal((await booking(b)).status, "used");
  }
  await assert.rejects(
    pool.query("UPDATE bookings SET status='expired' WHERE id=$1", [b.id]),
    { code: "23514" },
  );
  assert.equal(await count("booking_refunds"), 0);
});
test("L10: completed session without a confirmed start uses its session refund only", async () => {
  const b = await paid();
  const s = await start(b);
  await stopSession(pool, driver, s.id, randomUUID());
  await cycle();
  assert.equal((await current(s)).startConfirmedAt, null);
  await assert.rejects(cancelBooking(pool, driver, b.id), { status: 409 });
  assert.equal(await count("booking_refunds"), 0);
  assert.equal(await count("session_refunds"), 1);
  assert.equal(await reservation(b), "released");
});
test("L11: availability counts a no-show as occupied until an SQL transition actually releases it", async () => {
  const b = await paid({ offset: -16 * 60000 });
  const at = new Date(Date.now() + 60000).toISOString();
  const url =
    "/api/stations/tverskaya-plaza/availability?" +
    new URLSearchParams({ start: at, duration: "30", connector: "CCS2" });
  const before = await request(url);
  assert.equal(before.data.available, 3);
  await recoverBookingLifecycle(pool);
  const after = await request(url);
  assert.equal(after.data.available, 4);
  const next = await paid({ user: other, startAt: new Date(at) });
  assert.equal(next.connectorId, b.connectorId);
});
test("L12: two refund workers use one durable receipt and never regress succeeded", async () => {
  const b = await paid();
  const v = await cancelBooking(pool, driver, b.id);
  await Promise.all([
    recoverBookingRefund(pool, v!.refund!.id),
    recoverBookingRefund(pool, v!.refund!.id),
  ]);
  assert.equal(await count("test_booking_refund_receipts"), 1);
  assert.equal((await booking(b)).refund!.status, "succeeded");
});
test("L13: failure before adapter receipt leaves submitted intent for restart", async () => {
  const b = await paid();
  const v = await cancelBooking(pool, driver, b.id);
  await assert.rejects(
    recoverBookingRefund(pool, v!.refund!.id, async () => {
      throw new Error("offline");
    }),
  );
  assert.equal(await count("test_booking_refund_receipts"), 0);
  assert.equal(
    (await pool.query("SELECT status FROM booking_refunds")).rows[0].status,
    "submitted",
  );
  await closed(b);
  assert.equal((await booking(b)).refund!.status, "succeeded");
});
test("L14: failure after adapter receipt recovers the same provider operation", async () => {
  const b = await paid();
  const v = await cancelBooking(pool, driver, b.id);
  await assert.rejects(
    recoverBookingRefund(pool, v!.refund!.id, async (p, id) => {
      await confirmTestBookingRefund(p, id);
      throw new Error("crash after receipt");
    }),
  );
  assert.equal(await count("test_booking_refund_receipts"), 1);
  await closed(b);
  assert.equal(await count("test_booking_refund_receipts"), 1);
});
test("L15: fake adapter response without a saved receipt never completes booking refund", async () => {
  const b = await paid();
  const v = await cancelBooking(pool, driver, b.id);
  await assert.rejects(
    recoverBookingRefund(
      pool,
      v!.refund!.id,
      async () =>
        (
          await pool.query("SELECT * FROM booking_refunds WHERE id=$1", [
            v!.refund!.id,
          ])
        ).rows[0],
    ),
  );
  assert.equal(
    (await pool.query("SELECT status FROM booking_refunds")).rows[0].status,
    "submitted",
  );
});
test("L16: combined compensation/session/booking budget cannot exceed actual payment", async () => {
  const b = await paid();
  await cancelBooking(pool, driver, b.id);
  await assert.rejects(
    pool.query(
      "INSERT INTO payment_compensations(payment_id,attempt_id,amount_kopecks,reason) VALUES($1,$2,1,'extra_success')",
      [b.paymentId, b.attemptId],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query("UPDATE booking_refunds SET amount_kopecks=amount_kopecks+1"),
    { code: "23514" },
  );
});
test("L17: rollback halfway through close leaves original confirmed booking and no refund", async () => {
  const b = await paid();
  await pool.query(
    "CREATE FUNCTION break_closure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rollback'; END $$; CREATE TRIGGER break_closure BEFORE INSERT ON booking_refunds FOR EACH ROW EXECUTE FUNCTION break_closure()",
  );
  try {
    await assert.rejects(cancelBooking(pool, driver, b.id));
  } finally {
    await pool.query(
      "DROP TRIGGER break_closure ON booking_refunds; DROP FUNCTION break_closure()",
    );
  }
  assert.equal(await reservation(b), "confirmed");
  assert.equal(await count("booking_closures"), 0);
  assert.equal(await count("booking_refunds"), 0);
  assert.equal((await cancelBooking(pool, driver, b.id))!.status, "cancelled");
});
test("L18: actual OS process restart recovers overdue no-show and submitted refund", async () => {
  const b = await paid({ offset: 60000 });
  const v = await cancelBooking(pool, driver, b.id);
  await assert.rejects(
    recoverBookingRefund(pool, v!.refund!.id, async () => {
      throw new Error("offline");
    }),
  );
  const due = await paid({ user: other, port: 1, offset: -16 * 60000 });
  let child = await processServer();
  await stopProcess(child.child);
  child = await processServer();
  try {
    for (let i = 0; i < 40; i++) {
      if (
        (
          await pool.query(
            "SELECT count(*)::int n FROM booking_refunds WHERE status='succeeded'",
          )
        ).rows[0].n === 2
      )
        break;
      await delay(100);
    }
    assert.equal((await booking(b)).refund!.status, "succeeded");
    assert.equal((await booking(due)).status, "expired");
    assert.equal(await count("test_booking_refund_receipts"), 2);
  } finally {
    await stopProcess(child.child);
  }
});
test("L19: owner only HTTP cancellation; foreign driver 404, operators 403, strict body", async () => {
  const b = await paid();
  const url = "/api/bookings/" + b.id + "/cancel";
  assert.equal((await request(url, "POST", {}, tokens[other])).status, 404);
  assert.equal((await request(url, "POST", {}, tokens[operator])).status, 403);
  assert.equal(
    (await request(url, "POST", {}, tokens[foreignOperator])).status,
    403,
  );
  assert.equal((await request(url, "POST", { amount: 0 })).status, 400);
  assert.equal((await request(url, "POST", {})).status, 200);
  assert(
    !(
      await request("/api/workspace", "GET", undefined, tokens[other])
    ).data.bookings.some((x: any) => x.id === b.id),
  );
});
test("L20: repeated provider success after cancellation never revives original reservation", async () => {
  const b = await paid();
  await cancelBooking(pool, driver, b.id);
  await closed(b);
  const eid = (
    await pool.query(
      "INSERT INTO payment_events(attempt_id,provider_event_id,kind,request_hash,result) VALUES($1,$2,'succeeded',$3,'awaiting_booking') RETURNING id",
      [b.attemptId, randomUUID(), "b".repeat(64)],
    )
  ).rows[0].id;
  await transaction(pool, (db) => finalizePayment(db, b.paymentId, eid));
  await transaction(pool, (db) => finalizePayment(db, b.paymentId, eid));
  assert.equal(await reservation(b), "released");
  assert.equal((await booking(b)).status, "cancelled");
  assert.equal(await count("booking_refunds"), 1);
  assert.equal(await count("payment_compensations"), 0);
});
test("L21: new session cannot appear after a durable closure even through direct SQL", async () => {
  const b = await paid();
  await cancelBooking(pool, driver, b.id);
  await assert.rejects(start(b), { status: 409 });
  await assert.rejects(
    pool.query(
      `INSERT INTO charging_sessions(booking_id,payment_id,funding_attempt_id,user_id,organization_id,station_id,connector_id,connector_type,window_start,window_end,prepaid_kopecks,tariff_kopecks,energy_budget_wh,allocated_power_w,battery_capacity_kwh)
    SELECT b.id,b.payment_id,b.payment_attempt_id,b.user_id,b.organization_id,b.station_id,b.connector_id,b.connector_type,b.start_at,b.end_at,b.amount_kopecks,1800,1000,1000,75 FROM bookings b WHERE b.id=$1`,
      [b.id],
    ),
    { code: "23514" },
  );
});
test("L22: cancel during valid start window is permitted without fees, but never changes terminal reason", async () => {
  const b = await paid({ offset: -5 * 60000 });
  const v = await cancelBooking(pool, driver, b.id);
  assert.equal(v!.status, "cancelled");
  assert.equal(v!.refund!.amountKopecks, 10000);
  await recoverBookingLifecycle(pool);
  assert.equal((await booking(b)).closureReason, "driver");
});
test("L23: no-show immediately before boundary leaves the port confirmed and has no refund", async () => {
  const b = await paid({ startAt: new Date(Date.now() - 14 * 60000) });
  await recoverBookingLifecycle(pool);
  assert.equal(await reservation(b), "confirmed");
  assert.equal(await count("booking_refunds"), 0);
  const d = (
    await pool.query(
      "SELECT booking_start_deadline('2026-01-01T00:00Z','2026-01-01T00:10Z')= '2026-01-01T00:10Z'::timestamptz shorter, booking_start_deadline('2026-01-01T00:00Z','2026-01-01T01:00Z')<= '2026-01-01T00:15Z'::timestamptz exact",
    )
  ).rows[0];
  assert(d.shorter && d.exact);
});
test("L24: signed repeated webhook after no-show or cancellation cannot resurrect either booking", async () => {
  for (const offset of [-1000, -16 * 60000]) {
    await pool.query("TRUNCATE payments,connector_reservations CASCADE");
    const b = await paid({ offset });
    await cancelBooking(pool, driver, b.id);
    await closed(b);
    const options = {
      publicOrigin: "https://api.fixture.test",
      secret: "s".repeat(48),
    };
    const event = {
      providerEventId: randomUUID(),
      providerPaymentId: b.attemptId,
      outcome: "succeeded" as const,
      amountKopecks: 10000,
      currency: "RUB" as const,
    };
    const signed = signEvent(options, event);
    await processSignedEvent(
      pool,
      options,
      signed.body,
      signed.timestamp,
      signed.signature,
    );
    const again = await processSignedEvent(
      pool,
      options,
      signed.body,
      signed.timestamp,
      signed.signature,
    );
    assert.equal(again.duplicate, true);
    assert.equal(
      (await booking(b)).status,
      offset < -60000 ? "expired" : "cancelled",
    );
    assert.equal(await count("booking_refunds"), 1);
    assert.equal(await count("bookings"), 1);
  }
});
test("L25: concurrent start and no-show after waiting past deadline selects expiry, never a session", async () => {
  const b = await paid({ offset: -15 * 60000 + 800 });
  const db = await pool.connect();
  await db.query("BEGIN");
  await db.query("SELECT id FROM payments WHERE id=$1 FOR UPDATE", [
    b.paymentId,
  ]);
  try {
    const starting = start(b);
    const outcome = starting.then(
      () => true,
      () => false,
    );
    await delay(1000);
    const expiring = recoverBookingLifecycle(pool);
    // The no-show candidate must be due BEFORE selection, and must actually wait
    // behind the in-flight start's driver lock while start waits for payment.
    let waiting = false;
    for (let i = 0; i < 50; i++) {
      waiting = (
        await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE '%pg_advisory_xact_lock(hashtextextended%') waiting`)
      ).rows[0].waiting;
      if (waiting) break;
      await delay(20);
    }
    assert.equal(waiting, true, "No-show must overlap the blocked start");
    await db.query("COMMIT");
    await expiring;
    assert.equal(await outcome, false);
    assert.equal(
      (await pool.query("SELECT status FROM bookings WHERE id=$1", [b.id]))
        .rows[0].status,
      "expired",
    );
    assert.equal(await count("charging_sessions"), 0);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
});
