import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import type { Server } from "node:http";
import "../src/config/env.js";
import { createPool, transaction, type Database } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { seed, demoOrganizationId } from "../seeds/seed.js";
import { createApp } from "../src/app.js";
import {
  createPayment,
  getPayment,
  cancelPayment,
  retryPayment,
  processSignedEvent,
  recoverPayments,
} from "../src/modules/payments/service.js";
import {
  recoverCompensation,
  confirmTestRefund,
} from "../src/modules/payments/finalization.js";
import { signEvent, hash } from "../src/modules/payments/provider.js";
import { providerEvent } from "../src/modules/payments/validation.js";

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith("_test"))
  throw new Error("Dedicated _test database required");
const schema = `test_${randomBytes(10).toString("hex")}`,
  admin = createPool(connection);
const options = {
  publicOrigin: "https://provider.example.test",
  secret: "finalization-isolated-test-secret-not-production",
};
let pool: Database,
  driver: string,
  other: string,
  driverToken: string,
  otherToken: string,
  server: Server,
  base: string;
const input = () => ({
  input: {
    stationId: "solo-final",
    connector: "CCS2",
    start: new Date(Date.now() + 86400000).toISOString(),
    duration: 60,
    payment: "card",
  },
});
const create = async (ttl = 900, user = driver, body = input()) =>
  (
    await createPayment(
      pool,
      { ...options, holdTtlSeconds: ttl },
      user,
      randomUUID(),
      body,
    )
  ).payment;
const current = (p: any, user = driver) =>
  getPayment(pool, options, user, p.id);
function signed(
  p: any,
  id = randomUUID(),
  outcome: "succeeded" | "failed" = "succeeded",
) {
  return signEvent(options, {
    providerEventId: id,
    providerPaymentId: p.attempt.id,
    outcome,
    amountKopecks: p.amountKopecks,
    currency: "RUB",
  });
}
async function send(
  p: any,
  id = randomUUID(),
  outcome: "succeeded" | "failed" = "succeeded",
) {
  const s = signed(p, id, outcome);
  return processSignedEvent(pool, options, s.body, s.timestamp, s.signature);
}
async function api(path: string, token = driverToken) {
  const r = await fetch(base + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(r.status, 200);
  return r.json() as Promise<any>;
}
const count = async (table: string) =>
  (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function legacy(p: any, id = randomUUID()) {
  const s = signed(p, id),
    event = providerEvent.parse(JSON.parse(s.body.toString()));
  await transaction(pool, async (db) => {
    await db.query(
      "UPDATE payments SET provider_success_received_at=clock_timestamp() WHERE id=$1",
      [p.id],
    );
    await db.query(
      "UPDATE payment_attempts SET status='succeeded',resolved_at=clock_timestamp() WHERE id=$1",
      [p.attempt.id],
    );
    await db.query(
      "INSERT INTO payment_events(attempt_id,provider_event_id,kind,request_hash,result,processed_at) VALUES($1,$2,'succeeded',$3,'awaiting_booking',clock_timestamp())",
      [p.attempt.id, id, hash(JSON.stringify(event))],
    );
  });
  return id;
}
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = createPool(connection, schema);
  await migrate(pool);
  await seed(pool, "FinalFixture12345", "FinalFixture12345");
  await pool.query(
    "INSERT INTO stations(id,organization_id,name,address,district,longitude,latitude,max_power_kw,limit_kw,price_per_kwh_kopecks,operating_state) VALUES('solo-final',$1,'Test','Test','Test',37,55,50,50,1800,'online')",
    [demoOrganizationId],
  );
  await pool.query(
    "INSERT INTO connectors(station_id,label,type,max_power_kw,operating_state) VALUES('solo-final','1','CCS2',50,'idle')",
  );
  server = createApp(pool, {
    origins: [],
    AUTH_TTL_SECONDS: 3600,
    PAYMENT_PUBLIC_ORIGIN: options.publicOrigin,
    PAYMENT_WEBHOOK_SECRET: options.secret,
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
  for (const email of [
    "driver@energotransport.test",
    "driver2@energotransport.test",
  ]) {
    const r = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "FinalFixture12345",
        role: "driver",
      }),
    });
    assert.equal(r.status, 200);
    const a: any = await r.json();
    if (email.startsWith("driver@")) {
      driver = a.user.id;
      driverToken = a.token;
    } else {
      other = a.user.id;
      otherToken = a.token;
    }
  }
});
beforeEach(async () => {
  await pool.query("TRUNCATE payments,connector_reservations CASCADE");
  await pool.query("UPDATE connectors SET operating_state='idle'");
  await pool.query("UPDATE stations SET operating_state='online'");
});
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await pool?.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

test("F00: 004 migration repeats and database refuses business success without booking", async () => {
  await migrate(pool);
  assert.equal(await count("schema_migrations"), 9);
  const p = await create();
  await assert.rejects(
    pool.query("UPDATE payments SET status='succeeded' WHERE id=$1", [p.id]),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query(
      "UPDATE connector_reservations SET state='confirmed' WHERE payment_id=$1",
      [p.id],
    ),
    { code: "23514" },
  );
  assert.equal((await current(p)).status, "pending");
});
test("F01: signed success commits one booking, exact physical snapshot, reservation, payment and event", async () => {
  const p = await create();
  assert.equal((await send(p)).result, "finalized");
  const result = await current(p);
  assert.equal(result.status, "succeeded");
  assert(result.bookingId);
  assert.equal(result.reservation.state, "confirmed");
  const b = (await api("/api/workspace")).bookings[0];
  assert.equal(b.id, result.bookingId);
  assert.equal(b.userId, driver);
  assert.equal(b.connectorId, p.reservation.connectorId);
  assert.equal(b.start, p.input.start);
  assert.equal(b.amount, p.amount);
  assert.equal(
    (await pool.query("SELECT result FROM payment_events")).rows[0].result,
    "finalized",
  );
});
test("F02: duplicate event preserves booking ID, count, finalized time and processed time", async () => {
  const p = await create(),
    id = randomUUID();
  await send(p, id);
  const before = (
    await pool.query("SELECT finalized_at FROM payments WHERE id=$1", [p.id])
  ).rows[0];
  const booking = (await current(p)).bookingId;
  const processed = (
    await pool.query("SELECT processed_at FROM payment_events")
  ).rows[0].processed_at.toISOString();
  assert.equal((await send(p, id)).duplicate, true);
  assert.equal(await count("bookings"), 1);
  assert.equal((await current(p)).bookingId, booking);
  assert.equal(
    (
      await pool.query("SELECT finalized_at FROM payments WHERE id=$1", [p.id])
    ).rows[0].finalized_at.toISOString(),
    before.finalized_at.toISOString(),
  );
  assert.equal(
    (
      await pool.query("SELECT processed_at FROM payment_events")
    ).rows[0].processed_at.toISOString(),
    processed,
  );
});
test("F03: concurrent successes, same and different event IDs, create exactly one booking", async () => {
  const p = await create(),
    id = randomUUID();
  const results = await Promise.all([
    send(p, id),
    send(p, id),
    send(p),
    send(p),
  ]);
  assert(results.every((r) => r.received));
  assert.equal(await count("bookings"), 1);
  assert.equal(await count("payment_events"), 3);
  assert.equal(await count("payment_compensations"), 0);
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
      PAYMENT_PUBLIC_ORIGIN: options.publicOrigin,
      PAYMENT_WEBHOOK_SECRET: options.secret,
    },
  });
  const address = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Child startup timeout"));
    }, 15000);
    child.stdout?.on("data", (chunk) => {
      const m = String(chunk).match(
        /API listening on (http:\/\/127\.0\.0\.1:\d+)/,
      );
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Child exited before readiness"));
    });
  });
  return { child, address };
}
async function stop(child: ChildProcess) {
  const done = once(child, "exit");
  child.kill();
  await done;
}
test("F04: a confirmed booking and repeated signed webhook survive actual process restart", async () => {
  const p = await create(),
    id = randomUUID();
  let booking: string | undefined;
  for (let i = 0; i < 2; i++) {
    const child = await processServer();
    try {
      const s = signed(p, id);
      const r = await fetch(
        child.address + "/api/integrations/payments/test/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Test-Payment-Timestamp": s.timestamp,
            "X-Test-Payment-Signature": s.signature,
          },
          body: s.body,
        },
      );
      assert.equal(r.status, 200);
      const state = (await fetch(child.address + "/api/workspace", {
        headers: { Authorization: `Bearer ${driverToken}` },
      }).then((r) => r.json())) as any;
      assert.equal(state.bookings.length, 1);
      if (booking) assert.equal(state.bookings[0].id, booking);
      booking = state.bookings[0].id;
    } finally {
      await stop(child.child);
    }
  }
});
test("F05: failure after booking insert rolls back payment, reserve, attempt and inbox; replay then succeeds", async () => {
  const p = await create(),
    id = randomUUID();
  await pool.query(
    "CREATE FUNCTION inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'Injected rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER inject_failure BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION inject_failure()",
  );
  try {
    await assert.rejects(send(p, id), /Injected rollback/);
  } finally {
    await pool.query(
      "DROP TRIGGER inject_failure ON payments; DROP FUNCTION inject_failure()",
    );
  }
  assert.equal(await count("bookings"), 0);
  assert.equal(await count("payment_events"), 0);
  const original = await current(p);
  assert.equal(original.status, "pending");
  assert.equal(original.attempt.status, "pending");
  assert.equal(original.reservation.state, "held");
  assert.equal(original.providerSuccessReceived, false);
  assert.equal((await send(p, id)).result, "finalized");
});
test("F06: expired hold cannot become a historical booking and queues one compensation", async () => {
  const p = await create(1),
    id = randomUUID();
  await delay(1200);
  await send(p, id);
  await send(p, id);
  const r = await current(p);
  assert.equal(r.bookingId, null);
  assert.equal(r.reservation.state, "expired");
  assert.equal(r.finalizationReason, "hold_expired");
  assert.equal(r.refunds.length, 1);
  assert.equal(r.refunds[0].status, "pending");
  assert.equal(r.refunds[0].confirmedAt, null);
});
test("F07: late success never takes a released physical port from another driver", async () => {
  const body = input(),
    p = await create(900, driver, body);
  await cancelPayment(pool, options, driver, p.id);
  const replacement = await create(900, other, body);
  await send(replacement);
  await send(p);
  assert.equal((await current(p)).bookingId, null);
  assert.equal((await current(p)).finalizationReason, "hold_released");
  assert.equal((await current(replacement, other)).status, "succeeded");
  assert.equal(await count("bookings"), 1);
});
test("F08: port goes offline during payment; success is preserved but cannot confirm", async () => {
  const p = await create();
  await pool.query(
    "UPDATE connectors SET operating_state='service' WHERE id=$1",
    [p.reservation.connectorId],
  );
  await send(p);
  const r = await current(p);
  assert.equal(r.bookingId, null);
  assert.equal(r.providerSuccessReceived, true);
  assert.equal(r.finalizationReason, "port_unavailable");
  assert.equal(r.reservation.state, "released");
});
test("F09: compensation remains submitted on adapter failure and becomes completed only after receipt", async () => {
  const p = await create();
  await cancelPayment(pool, options, driver, p.id);
  await send(p);
  const id = (await current(p)).refunds[0].id;
  await assert.rejects(
    recoverCompensation(pool, id, async () => {
      throw new Error("Adapter offline");
    }),
    /Adapter offline/,
  );
  const waiting = await current(p);
  assert.equal(waiting.refunds[0].status, "submitted");
  assert.equal(waiting.refunds[0].confirmedAt, null);
  assert.equal(await count("test_refund_receipts"), 0);
  await assert.rejects(
    pool.query(
      "UPDATE payment_compensations SET status='succeeded',confirmed_at=clock_timestamp() WHERE id=$1",
      [id],
    ),
    { code: "23503" },
  );
  await recoverCompensation(pool, id);
  const done = await current(p);
  assert.equal(done.refunds[0].status, "succeeded");
  assert(done.refunds[0].confirmedAt);
  assert.equal(done.reconciliationRequired, false);
  assert.equal(done.bookingId, null);
});
test("F10: crash after adapter receipt before application confirmation recovers with same refund ID", async () => {
  const p = await create();
  await cancelPayment(pool, options, driver, p.id);
  await send(p);
  const id = (await current(p)).refunds[0].id;
  await assert.rejects(
    recoverCompensation(pool, id, async (db, cid) => {
      await confirmTestRefund(db, cid);
      throw new Error("Crash after receipt");
    }),
    /Crash after receipt/,
  );
  assert.equal((await current(p)).refunds[0].status, "submitted");
  assert.equal(await count("test_refund_receipts"), 1);
  const child = await processServer();
  try {
    for (let i = 0; i < 30; i++) {
      if ((await current(p)).refunds[0].status === "succeeded") break;
      await delay(100);
    }
    assert.equal((await current(p)).refunds[0].status, "succeeded");
  } finally {
    await stop(child.child);
  }
  await recoverPayments(pool);
  assert.equal(await count("test_refund_receipts"), 1);
  assert.equal(await count("payment_compensations"), 1);
});
test("F11: duplicate of Stage 3B awaiting_booking event performs missing finalization", async () => {
  const p = await create(),
    id = await legacy(p);
  assert.equal((await current(p)).awaitingFinalization, true);
  const r = await send(p, id);
  assert.equal(r.duplicate, true);
  assert.equal(r.result, "finalized");
  assert.equal((await current(p)).status, "succeeded");
  assert.equal(await count("bookings"), 1);
});
test("F12: boot recovery of expired Stage 3B success compensates instead of resurrecting booking", async () => {
  const p = await create(1);
  await legacy(p);
  await delay(1200);
  const child = await processServer();
  try {
    for (let i = 0; i < 30; i++) {
      if ((await current(p)).refunds[0]?.status === "succeeded") break;
      await delay(100);
    }
    const r = await current(p);
    assert.equal(r.bookingId, null);
    assert.equal(r.finalizationReason, "hold_expired");
    assert.equal(r.refunds[0].status, "succeeded");
  } finally {
    await stop(child.child);
  }
});
test("F13: workspace survives repeat login, isolates other driver and exposes no foreign booking/payment", async () => {
  const p = await create();
  await send(p);
  assert.equal((await api("/api/workspace")).bookings.length, 1);
  const theirs = await api("/api/workspace", otherToken);
  assert.equal(theirs.bookings.length, 0);
  assert.equal(theirs.payments.length, 0);
  await assert.rejects(current(p, other), { status: 404 });
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "driver@energotransport.test",
      password: "FinalFixture12345",
      role: "driver",
    }),
  });
  assert.equal(login.status, 200);
  const reentered: any = await login.json();
  assert.equal(
    (await api("/api/workspace", reentered.token)).bookings[0].paymentId,
    p.id,
  );
});
test("F14: SQL rejects changed booking snapshot and paid reserve detached from booking", async () => {
  const p = await create();
  await send(p);
  const b = (await current(p)).bookingId;
  await assert.rejects(
    pool.query("UPDATE bookings SET user_id=$2 WHERE id=$1", [b, other]),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query(
      "UPDATE connector_reservations SET state='released' WHERE payment_id=$1",
      [p.id],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query(
      "UPDATE payments SET status='pending',booking_id=NULL WHERE id=$1",
      [p.id],
    ),
    { code: "23514" },
  );
});
test("F15: success of another attempt after confirmed booking compensates extra attempt only", async () => {
  const p = await create();
  await send(p, randomUUID(), "failed");
  const retried = await retryPayment(pool, options, driver, p.id, randomUUID());
  await send(retried);
  const booking = (await current(p)).bookingId;
  await send(p);
  const result = await current(p);
  assert.equal(result.status, "succeeded");
  assert.equal(result.bookingId, booking);
  assert.equal(result.reservation.state, "confirmed");
  assert.equal(result.refunds[0].reason, "extra_success");
  await recoverPayments(pool);
  assert.equal(await count("bookings"), 1);
  assert.equal(await count("test_refund_receipts"), 1);
});
test("F16: old failed attempt succeeds during retry; new attempt is cancelled, refund queued once", async () => {
  const p = await create();
  await send(p, randomUUID(), "failed");
  await retryPayment(pool, options, driver, p.id, randomUUID());
  await send(p);
  const r = await current(p);
  assert.equal(r.bookingId, null);
  assert.equal(r.attempt.status, "cancelled");
  assert.equal(r.finalizationReason, "attempt_not_current");
  assert.equal(r.refunds[0].status, "pending");
});
test("F17: lock wait crosses PostgreSQL hold deadline; finalizer rechecks after acquiring locks", async () => {
  const p = await create(1);
  const blocker = await pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM connectors WHERE id=$1 FOR UPDATE", [
    p.reservation.connectorId,
  ]);
  const event = send(p);
  await delay(1200);
  await blocker.query("COMMIT");
  blocker.release();
  await event;
  const result = await current(p);
  assert.equal(result.bookingId, null);
  assert.equal(result.finalizationReason, "hold_expired");
});
test("F18: composite FK refuses booking for another user and another payment reservation", async () => {
  const p = await create();
  await assert.rejects(
    pool.query(
      `INSERT INTO bookings(payment_id,reservation_id,payment_attempt_id,user_id,organization_id,station_id,connector_id,connector_type,start_at,end_at,amount_kopecks,method)
   SELECT id,$2,$3,$4,organization_id,station_id,connector_id,requested_connector_type,start_at,end_at,amount_kopecks,method FROM payments WHERE id=$1`,
      [p.id, p.reservation.id, p.attempt.id, other],
    ),
    { code: "23503" },
  );
  assert.equal(await count("bookings"), 0);
});
test("F19: forged adapter reply cannot complete compensation and confirmed receipt cannot be erased", async () => {
  const p = await create();
  await cancelPayment(pool, options, driver, p.id);
  await send(p);
  const id = (await current(p)).refunds[0].id;
  const c = (
    await pool.query("SELECT * FROM payment_compensations WHERE id=$1", [id])
  ).rows[0];
  await assert.rejects(
    recoverCompensation(pool, id, async () => ({
      provider_refund_id: c.provider_refund_id,
      amount_kopecks: c.amount_kopecks,
      confirmed_at: new Date(),
    })),
    /Durable refund receipt missing/,
  );
  assert.equal((await current(p)).refunds[0].status, "submitted");
  await recoverCompensation(pool, id);
  await assert.rejects(
    pool.query("DELETE FROM test_refund_receipts WHERE compensation_id=$1", [
      id,
    ]),
    { code: "23503" },
  );
  await assert.rejects(
    pool.query(
      "UPDATE payment_compensations SET status='pending',confirmed_at=NULL WHERE id=$1",
      [id],
    ),
    { code: "23514" },
  );
});
test("F20: parallel compensation recovery reuses one provider refund and one receipt", async () => {
  const p = await create();
  await cancelPayment(pool, options, driver, p.id);
  await send(p);
  const id = (await current(p)).refunds[0].id;
  await Promise.all([
    recoverCompensation(pool, id),
    recoverCompensation(pool, id),
  ]);
  assert.equal(await count("test_refund_receipts"), 1);
  assert.equal((await current(p)).refunds[0].status, "succeeded");
});
test("F21: another success event ID after completed refund preserves completed reconciliation", async () => {
  const p = await create();
  await cancelPayment(pool, options, driver, p.id);
  await send(p);
  await recoverPayments(pool);
  assert.equal((await current(p)).reconciliationRequired, false);
  await send(p);
  await send(p);
  const result = await current(p);
  assert.equal(result.reconciliationRequired, false);
  assert.equal(result.refunds.length, 1);
  assert.equal(result.refunds[0].status, "succeeded");
  assert.equal(result.bookingId, null);
  assert.equal(await count("test_refund_receipts"), 1);
  assert.equal(await count("bookings"), 0);
});
