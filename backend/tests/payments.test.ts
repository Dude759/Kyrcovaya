import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Server } from "node:http";
import "../src/config/env.js";
import { createPool, type Database } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { seed, demoOrganizationId } from "../seeds/seed.js";
import { createApp } from "../src/app.js";
import {
  signEvent,
  type PaymentOptions,
} from "../src/modules/payments/provider.js";

const connection = process.env.TEST_DATABASE_URL;
if (!connection || !new URL(connection).pathname.endsWith("_test"))
  throw new Error("Separate TEST_DATABASE_URL ending in _test required");
const schema = `test_${randomBytes(10).toString("hex")}`,
  admin = createPool(connection);
const options: PaymentOptions = {
  publicOrigin: "https://provider.example.test",
  secret: "integration-only-private-test-signing-key-3b",
};
const password = "PaymentFixture12345";
let pool: Database,
  server: Server,
  base: string,
  driver: string,
  driver2: string,
  operator: string;
function input(stationId = "tverskaya-plaza", offset = 0) {
  return {
    input: {
      stationId,
      connector: "CCS2",
      start: new Date(
        Math.ceil(Date.now() / 60000) * 60000 + 86400000 + offset * 60000,
      ).toISOString(),
      duration: 60,
      payment: "card",
    },
  };
}
type RequestOptions = {
  headers?: Record<string, string>;
  raw?: string | Buffer;
  contentType?: string;
};
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
  key?: string,
  opts: RequestOptions = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": opts.contentType ?? "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
      ...opts.headers,
    },
    ...(opts.raw !== undefined
      ? { body: opts.raw }
      : body === undefined
        ? {}
        : { body: JSON.stringify(body) }),
  });
  const data: any =
    response.status === 204
      ? null
      : response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : await response.text();
  return { status: response.status, data, headers: response.headers };
}
async function create(body = input(), token = driver, key = randomUUID()) {
  const result = await request("/api/payments", "POST", body, token, key);
  assert.equal(result.status, 201);
  return result.data;
}
async function event(
  p: any,
  outcome: "succeeded" | "failed" | "cancelled",
  eventId = randomUUID(),
  overrides: Record<string, unknown> = {},
) {
  const payload = {
    providerEventId: eventId,
    providerPaymentId: p.attempt.id,
    outcome,
    amountKopecks: p.amountKopecks,
    currency: "RUB" as const,
    ...overrides,
  };
  const signed = signEvent(options, payload);
  return request(
    "/api/integrations/payments/test/events",
    "POST",
    undefined,
    undefined,
    undefined,
    {
      raw: signed.body,
      headers: {
        "X-Test-Payment-Timestamp": signed.timestamp,
        "X-Test-Payment-Signature": signed.signature,
      },
    },
  );
}
async function counts() {
  return (
    await pool.query(`SELECT (SELECT count(*)::int FROM payments) AS payments,
  (SELECT count(*)::int FROM payment_attempts) AS attempts,(SELECT count(*)::int FROM connector_reservations) AS holds,
  (SELECT count(*)::int FROM payment_events) AS events`)
  ).rows[0];
}
const isCode = (code: string) => (error: unknown) =>
  (error as { code?: string }).code === code;
async function startServer(ttl = 900) {
  const value = createApp(pool, {
    origins: ["http://localhost:5173"],
    AUTH_TTL_SECONDS: 3600,
    PAYMENT_PUBLIC_ORIGIN: options.publicOrigin,
    PAYMENT_WEBHOOK_SECRET: options.secret,
    PAYMENT_HOLD_TTL_SECONDS: ttl,
  }).listen(0, "127.0.0.1");
  await once(value, "listening");
  const address = value.address();
  assert(address && typeof address === "object");
  return { server: value, address: `http://127.0.0.1:${address.port}` };
}
async function stopServer(value: Server) {
  value.closeAllConnections();
  await new Promise<void>((resolve) => value.close(() => resolve()));
}
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = createPool(connection, schema);
  await migrate(pool);
  await migrate(pool);
  await seed(pool, password, password);
  await pool.query(
    `INSERT INTO stations(id,organization_id,name,address,district,longitude,latitude,max_power_kw,limit_kw,price_per_kwh_kopecks,operating_state)
    VALUES ('solo-pay',$1,'Последний порт','Учебный адрес','Район',37,55,50,50,1800,'online')`,
    [demoOrganizationId],
  );
  await pool.query(
    "INSERT INTO connectors(station_id,label,type,max_power_kw,operating_state) VALUES ('solo-pay','1','CCS2',50,'idle')",
  );
  const s = await startServer();
  server = s.server;
  base = s.address;
  for (const [email, role, set] of [
    ["driver@energotransport.test", "driver", (v: string) => (driver = v)],
    ["driver2@energotransport.test", "driver", (v: string) => (driver2 = v)],
    [
      "operator@energotransport.test",
      "operator",
      (v: string) => (operator = v),
    ],
  ] as const) {
    const result = await request("/api/auth/login", "POST", {
      email,
      password,
      role,
    });
    assert.equal(result.status, 200);
    set(result.data.token);
  }
});
beforeEach(async () => {
  // Only our random isolated _test schema; never production data.
  await pool.query("DELETE FROM payment_events");
  await pool.query("DELETE FROM payment_attempts");
  await pool.query("DELETE FROM connector_reservations");
  await pool.query("DELETE FROM payments");
  await pool.query("UPDATE driver_profiles SET battery_capacity_kwh=75");
  await pool.query("UPDATE stations SET price_per_kwh_kopecks=1800");
});
after(async () => {
  if (server) await stopServer(server);
  if (pool) await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

test("P00: 003 applies and repeats; tables, unique/FK constraints and CORS header are real", async () => {
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM schema_migrations"))
      .rows[0].n,
    3,
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO payment_attempts(payment_id,attempt_no,provider_payment_id,confirmation_url) VALUES ($1,1,$2,'https://provider.example.test')",
      [randomUUID(), randomUUID()],
    ),
    isCode("23503"),
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO payment_events(attempt_id,provider_event_id,kind,request_hash,result) VALUES ($1,'orphan','failed',$2,'received')",
      [randomUUID(), "a".repeat(64)],
    ),
    isCode("23503"),
  );
  const preflight = await request(
    "/api/payments",
    "OPTIONS",
    undefined,
    undefined,
    undefined,
    {
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "Idempotency-Key,Authorization,Content-Type",
      },
    },
  );
  assert.equal(preflight.status, 204);
  assert.match(
    preflight.headers.get("access-control-allow-headers")!,
    /Idempotency-Key/i,
  );
});
test("P01: pending order, one physical hold and first provider attempt commit together", async () => {
  const p = await create();
  assert.equal(p.status, "pending");
  assert.equal(p.bookingId, null);
  assert.equal(p.amountKopecks, 40500);
  assert.equal(p.reservation.state, "held");
  assert.equal(p.attempt.number, 1);
  assert.equal(new URL(p.confirmationUrl).protocol, "https:");
  assert.deepEqual(await counts(), {
    payments: 1,
    attempts: 1,
    holds: 1,
    events: 0,
  });
  const r = (
    await pool.query(
      "SELECT * FROM connector_reservations WHERE payment_id=$1",
      [p.id],
    )
  ).rows[0];
  assert.equal(r.connector_id, p.reservation.connectorId);
  assert.equal(r.expires_at.toISOString(), p.expiresAt);
  assert(Date.parse(p.expiresAt) - Date.parse(p.createdAt) <= 900000);
  await assert.rejects(
    pool.query(
      "UPDATE connector_reservations SET start_at=start_at+interval '1 minute' WHERE id=$1",
      [r.id],
    ),
    isCode("23503"),
  );
});
test("P02: price is server-owned, order snapshot immutable, card/CVV payloads rejected", async () => {
  for (const body of [
    { ...input(), amount: 1 },
    { ...input(), cardNumber: "synthetic-invalid" },
    { input: { ...input().input, cvv: "invalid" } },
  ])
    assert.equal(
      (await request("/api/payments", "POST", body, driver, randomUUID()))
        .status,
      400,
    );
  const p = await create();
  assert.equal(p.amount, 405);
  await assert.rejects(
    pool.query("UPDATE payments SET amount_kopecks=1 WHERE id=$1", [p.id]),
    isCode("23514"),
  );
  await pool.query("UPDATE driver_profiles SET battery_capacity_kwh=100");
  await pool.query("UPDATE stations SET price_per_kwh_kopecks=9999");
  const current = await request(
    `/api/payments/${p.id}`,
    "GET",
    undefined,
    driver,
  );
  assert.equal(current.data.amount, 405);
  const columns = (
    await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name IN ('payments','payment_attempts','payment_events')",
      [schema],
    )
  ).rows;
  assert(
    !columns.some((c) => /card_number|cvv|(^|_)pan($|_)/.test(c.column_name)),
  );
});
test("P03: same user/key and canonical payload replay the order; keys are scoped per user", async () => {
  const body = input(),
    key = randomUUID(),
    p = await create(body, driver, key);
  const local = new Date(Date.parse(body.input.start) + 3 * 3600000)
    .toISOString()
    .replace("Z", "+03:00");
  const repeat = await request(
    "/api/payments",
    "POST",
    { input: { ...body.input, start: local } },
    driver,
    key,
  );
  assert.equal(repeat.status, 200);
  assert.equal(repeat.data.id, p.id);
  assert.equal(repeat.data.reservation.id, p.reservation.id);
  assert.deepEqual(await counts(), {
    payments: 1,
    attempts: 1,
    holds: 1,
    events: 0,
  });
  const other = await create(input("tverskaya-plaza", 120), driver2, key);
  assert.notEqual(other.id, p.id);
});
test("P04: same key with changed payload conflicts; missing/invalid key never creates a hold", async () => {
  const body = input(),
    key = randomUUID();
  await create(body, driver, key);
  assert.equal(
    (
      await request(
        "/api/payments",
        "POST",
        { input: { ...body.input, payment: "sbp" } },
        driver,
        key,
      )
    ).status,
    409,
  );
  for (const value of [undefined, "short", "bad key with spaces 1234"])
    assert.equal(
      (
        await request(
          "/api/payments",
          "POST",
          input("tverskaya-plaza", 120),
          driver,
          value,
        )
      ).status,
      400,
    );
  assert.equal((await counts()).holds, 1);
});
test("P05: concurrent POST with the same idempotency key creates exactly one order/hold/attempt", async () => {
  const body = input(),
    key = randomUUID();
  const results = await Promise.all([
    request("/api/payments", "POST", body, driver, key),
    request("/api/payments", "POST", body, driver, key),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  assert.equal(results[0].data.id, results[1].data.id);
  assert.deepEqual(await counts(), {
    payments: 1,
    attempts: 1,
    holds: 1,
    events: 0,
  });
});
test("P06: two drivers with different keys compete for the last physical port; only one wins", async () => {
  const body = input("solo-pay"),
    results = await Promise.all([
      request("/api/payments", "POST", body, driver, randomUUID()),
      request("/api/payments", "POST", body, driver2, randomUUID()),
    ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.deepEqual(await counts(), {
    payments: 1,
    attempts: 1,
    holds: 1,
    events: 0,
  });
});
test("P07: retry creates an attempt on the same immutable order and reacquires the same reservation", async () => {
  const p = await create();
  assert.equal((await event(p, "failed")).status, 200);
  await pool.query("UPDATE stations SET price_per_kwh_kopecks=9999");
  const key = randomUUID();
  const retry = await request(
    `/api/payments/${p.id}/retry`,
    "POST",
    {},
    driver,
    key,
  );
  assert.equal(retry.status, 200);
  assert.equal(retry.data.id, p.id);
  assert.equal(retry.data.attempt.number, 2);
  assert.equal(retry.data.amountKopecks, p.amountKopecks);
  assert.equal(retry.data.reservation.id, p.reservation.id);
  assert.equal(retry.data.reservation.connectorId, p.reservation.connectorId);
  assert.equal(retry.data.expiresAt, p.expiresAt);
  const repeated = await request(
    `/api/payments/${p.id}/retry`,
    "POST",
    {},
    driver,
    key,
  );
  assert.equal(repeated.data.attempt.id, retry.data.attempt.id);
  assert.equal(
    (
      await request(
        `/api/payments/${p.id}/retry`,
        "POST",
        {},
        driver,
        randomUUID(),
      )
    ).status,
    409,
  );
  assert.equal((await counts()).payments, 1);
  assert.equal((await counts()).holds, 1);
  assert.equal((await counts()).attempts, 2);
});
test("P08: cancel releases the hold and is idempotent; cancelled order cannot retry", async () => {
  const p = await create();
  for (let i = 0; i < 2; i++) {
    const result = await request(
      `/api/payments/${p.id}/cancel`,
      "POST",
      {},
      driver,
    );
    assert.equal(result.status, 200);
    assert.equal(result.data.status, "cancelled");
    assert.equal(result.data.reservation.state, "released");
  }
  assert.equal(
    (
      await request(
        `/api/payments/${p.id}/retry`,
        "POST",
        {},
        driver,
        randomUUID(),
      )
    ).status,
    409,
  );
});
test("P09: failure releases hold; an old attempt event cannot release the retry's hold", async () => {
  const p = await create();
  await event(p, "failed");
  const retry = await request(
    `/api/payments/${p.id}/retry`,
    "POST",
    {},
    driver,
    randomUUID(),
  );
  assert.equal(retry.status, 200);
  assert.equal((await event(p, "cancelled")).data.result, "ignored_terminal");
  let current = (
    await request(`/api/payments/${p.id}`, "GET", undefined, driver)
  ).data;
  assert.equal(current.status, "pending");
  assert.equal(current.reservation.state, "held");
  await event(current, "failed");
  current = (await request(`/api/payments/${p.id}`, "GET", undefined, driver))
    .data;
  assert.equal(current.status, "failed");
  assert.equal(current.reservation.state, "released");
});
test("P10: signed success resolves attempt only; payment stays pending and booking remains absent", async () => {
  const p = await create(),
    result = await event(p, "succeeded");
  assert.equal(result.status, 200);
  assert.equal(result.data.result, "awaiting_booking");
  const current = (
    await request(`/api/payments/${p.id}`, "GET", undefined, driver)
  ).data;
  assert.equal(current.attempt.status, "succeeded");
  assert.equal(current.status, "pending");
  assert.equal(current.awaitingFinalization, true);
  assert.equal(current.bookingId, null);
  assert.equal(current.confirmationUrl, undefined);
  assert.equal(current.reservation.state, "held");
  await assert.rejects(
    pool.query("UPDATE payments SET status='succeeded' WHERE id=$1", [p.id]),
    isCode("23514"),
  );
  assert.equal(
    (await request(`/api/payments/${p.id}/cancel`, "POST", {}, driver)).status,
    409,
  );
  assert.equal(
    (
      await request(
        `/api/payments/${p.id}/retry`,
        "POST",
        {},
        driver,
        randomUUID(),
      )
    ).status,
    409,
  );
  assert.equal(
    (await request("/api/bookings", "POST", {}, driver)).status,
    501,
  );
});
test("P11: missing, stale, wrong and body-tampered signatures rejected before any event writes", async () => {
  const p = await create(),
    payload = {
      providerEventId: randomUUID(),
      providerPaymentId: p.attempt.id,
      outcome: "succeeded" as const,
      amountKopecks: p.amountKopecks,
      currency: "RUB" as const,
    };
  const signed = signEvent(options, payload);
  for (const headers of [
    {},
    {
      "X-Test-Payment-Timestamp": signed.timestamp,
      "X-Test-Payment-Signature": "0".repeat(64),
    },
    (() => {
      const old = signEvent(
        options,
        payload,
        String(Math.floor(Date.now() / 1000) - 600),
      );
      return {
        "X-Test-Payment-Timestamp": old.timestamp,
        "X-Test-Payment-Signature": old.signature,
      };
    })(),
  ] as Record<string, string>[])
    assert.equal(
      (
        await request(
          "/api/integrations/payments/test/events",
          "POST",
          undefined,
          undefined,
          undefined,
          { raw: signed.body, headers },
        )
      ).status,
      401,
    );
  assert.equal(
    (
      await request(
        "/api/integrations/payments/test/events",
        "POST",
        undefined,
        undefined,
        undefined,
        {
          raw: Buffer.concat([signed.body, Buffer.from(" ")]),
          headers: {
            "X-Test-Payment-Timestamp": signed.timestamp,
            "X-Test-Payment-Signature": signed.signature,
          },
        },
      )
    ).status,
    401,
  );
  assert.equal(
    (await event(p, "succeeded", randomUUID(), { amountKopecks: 1 })).status,
    409,
  );
  assert.equal(
    (await event(p, "succeeded", randomUUID(), { cardNumber: "invalid" }))
      .status,
    400,
  );
  assert.equal((await counts()).events, 0);
});
test("P12: provider event deduplicates across reserialization; changed event content conflicts", async () => {
  const p = await create(),
    id = randomUUID();
  assert.equal((await event(p, "failed", id)).data.duplicate, false);
  const before = (
    await pool.query(
      "SELECT processed_at FROM payment_events WHERE provider_event_id=$1",
      [id],
    )
  ).rows[0].processed_at.toISOString();
  const body = Buffer.from(
      JSON.stringify(
        {
          currency: "RUB",
          amountKopecks: p.amountKopecks,
          outcome: "failed",
          providerPaymentId: p.attempt.id,
          providerEventId: id,
        },
        null,
        2,
      ),
    ),
    timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", options.secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
    .digest("hex");
  const replay = await request(
    "/api/integrations/payments/test/events",
    "POST",
    undefined,
    undefined,
    undefined,
    {
      raw: body,
      headers: {
        "X-Test-Payment-Timestamp": timestamp,
        "X-Test-Payment-Signature": signature,
      },
    },
  );
  assert.equal(replay.data.duplicate, true);
  assert.equal((await counts()).events, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT processed_at FROM payment_events WHERE provider_event_id=$1",
        [id],
      )
    ).rows[0].processed_at.toISOString(),
    before,
  );
  assert.equal((await event(p, "succeeded", id)).status, 409);
});
test("P13: another driver cannot read/retry/cancel; operator forbidden; invalid checkout capability rejected", async () => {
  const p = await create();
  for (const token of [driver2, operator])
    for (const [path, method] of [
      [`/api/payments/${p.id}`, "GET"],
      [`/api/payments/${p.id}/retry`, "POST"],
      [`/api/payments/${p.id}/cancel`, "POST"],
    ])
      assert.equal(
        (
          await request(
            path,
            method,
            method === "GET" ? undefined : {},
            token,
            randomUUID(),
          )
        ).status,
        token === driver2 ? 404 : 403,
      );
  assert.equal((await request(`/api/payments/${p.id}`)).status, 401);
  assert.equal(
    (await request(`/api/test-payments/${p.attempt.id}?token=invalid`)).status,
    401,
  );
});
test("P14: expired payment and hold are finalized lazily; expiry survives rejected retry and late success never resurrects", async () => {
  const short = await startServer(1),
    previous = base;
  let p: any;
  try {
    base = short.address;
    p = await create(input("solo-pay"));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const confirmation = new URL(p.confirmationUrl);
    assert.equal(
      (
        await request(
          `/api/test-payments/${p.attempt.id}`,
          "POST",
          undefined,
          undefined,
          undefined,
          {
            contentType: "application/x-www-form-urlencoded",
            raw: new URLSearchParams({
              token: confirmation.searchParams.get("token")!,
              outcome: "succeeded",
            }).toString(),
            headers: { Origin: options.publicOrigin },
          },
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          `/api/payments/${p.id}/retry`,
          "POST",
          {},
          driver,
          randomUUID(),
        )
      ).status,
      409,
    );
    assert.equal(
      (await pool.query("SELECT status FROM payments WHERE id=$1", [p.id]))
        .rows[0].status,
      "failed",
    );
    const current = (
      await request(`/api/payments/${p.id}`, "GET", undefined, driver)
    ).data;
    assert.equal(current.failure, "Время тестовой оплаты истекло.");
    assert.equal(current.reservation.state, "expired");
  } finally {
    base = previous;
    await stopServer(short.server);
  }
  const other = await create(input("solo-pay"), driver2);
  assert.equal(other.reservation.connectorId, p.reservation.connectorId);
  assert.equal((await event(p, "succeeded")).data.result, "late_success");
  const old = (await request(`/api/payments/${p.id}`, "GET", undefined, driver))
    .data;
  assert.equal(old.status, "failed");
  assert.equal(old.reconciliationRequired, true);
  assert.equal(old.bookingId, null);
  assert.equal(
    (await request(`/api/payments/${other.id}`, "GET", undefined, driver2)).data
      .reservation.state,
    "held",
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
      PAYMENT_PUBLIC_ORIGIN: options.publicOrigin,
      PAYMENT_WEBHOOK_SECRET: options.secret,
    },
  });
  const address = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Payment child startup timeout"));
    }, 15000);
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error("Payment child exited before listening"));
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
test("P15: real process restart between order creation and signed event preserves identity, hold and deduplication", async () => {
  const previous = base,
    body = input(),
    key = randomUUID();
  let p: any;
  const firstProcess = await startProcess();
  try {
    base = firstProcess.address;
    p = await create(body, driver, key);
  } finally {
    base = previous;
    await stopProcess(firstProcess.child);
  }
  const secondProcess = await startProcess();
  try {
    base = secondProcess.address;
    const replay = await request("/api/payments", "POST", body, driver, key);
    assert.equal(replay.data.id, p.id);
    assert.equal(replay.data.reservation.id, p.reservation.id);
    const id = randomUUID();
    assert.equal(
      (await event(p, "succeeded", id)).data.result,
      "awaiting_booking",
    );
    assert.equal((await event(p, "succeeded", id)).data.duplicate, true);
    const current = (
      await request(`/api/payments/${p.id}`, "GET", undefined, driver)
    ).data;
    assert.equal(current.status, "pending");
    assert.equal(current.awaitingFinalization, true);
    assert.deepEqual(await counts(), {
      payments: 1,
      attempts: 1,
      holds: 1,
      events: 1,
    });
  } finally {
    base = previous;
    await stopProcess(secondProcess.child);
  }
});
test("P16: provider HTTPS confirmation page has no card fields; signed form delivery is repeat-safe", async () => {
  const p = await create(),
    url = new URL(p.confirmationUrl),
    path = url.pathname + url.search;
  const page = await request(path);
  assert.equal(page.status, 200);
  assert.match(page.data, /Деньги не списываются/);
  assert(!/<input[^>]+name="(?:card|cvv|pan)/.test(page.data));
  assert.equal((await counts()).events, 0);
  const form = new URLSearchParams({
    token: url.searchParams.get("token")!,
    outcome: "succeeded",
  }).toString();
  assert.equal(
    (
      await request(url.pathname, "POST", undefined, undefined, undefined, {
        raw: form,
        contentType: "application/x-www-form-urlencoded",
        headers: { Origin: "https://foreign.example" },
      })
    ).status,
    403,
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await request(url.pathname, "POST", undefined, undefined, undefined, {
          raw: form,
          contentType: "application/x-www-form-urlencoded",
          headers: { Origin: options.publicOrigin },
        })
      ).status,
      200,
    );
  assert.equal((await counts()).events, 1);
  assert.equal(
    (await request(`/api/payments/${p.id}`, "GET", undefined, driver)).data
      .awaitingFinalization,
    true,
  );
});
test("P17: provider success does not extend TTL; expiry marks reconciliation without creating a booking", async () => {
  const short = await startServer(1),
    previous = base;
  try {
    base = short.address;
    const p = await create();
    await event(p, "succeeded");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      (await request(`/api/payments/${p.id}/cancel`, "POST", {}, driver))
        .status,
      409,
    );
    const current = (
      await request(`/api/payments/${p.id}`, "GET", undefined, driver)
    ).data;
    assert.equal(current.status, "failed");
    assert.equal(current.reconciliationRequired, true);
    assert.equal(current.reservation.state, "expired");
    assert.equal(current.bookingId, null);
  } finally {
    base = previous;
    await stopServer(short.server);
  }
});
test("P18: concurrent duplicate provider events commit one inbox row and one transition", async () => {
  const p = await create(),
    id = randomUUID(),
    results = await Promise.all([
      event(p, "failed", id),
      event(p, "failed", id),
    ]);
  assert(results.every((r) => r.status === 200));
  assert.equal(results.filter((r) => r.data.duplicate).length, 1);
  assert.equal((await counts()).events, 1);
  const current = (
    await request(`/api/payments/${p.id}`, "GET", undefined, driver)
  ).data;
  assert.equal(current.status, "failed");
  assert.equal(current.reservation.state, "released");
});
test("P19: cancel racing provider success has one coherent outcome, never a succeeded payment without booking", async () => {
  const p = await create();
  const [cancel, success] = await Promise.all([
    request(`/api/payments/${p.id}/cancel`, "POST", {}, driver),
    event(p, "succeeded"),
  ]);
  assert.equal(success.status, 200);
  assert([200, 409].includes(cancel.status));
  const current = (
    await request(`/api/payments/${p.id}`, "GET", undefined, driver)
  ).data;
  assert.equal(current.bookingId, null);
  assert.equal(current.providerSuccessReceived, true);
  if (cancel.status === 200) {
    assert.equal(current.status, "cancelled");
    assert.equal(current.reservation.state, "released");
    assert.equal(current.reconciliationRequired, true);
  } else {
    assert.equal(current.status, "pending");
    assert.equal(current.reservation.state, "held");
    assert.equal(current.awaitingFinalization, true);
  }
});
