import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const origin = new URL(process.argv[2]);
if (origin.protocol !== "https:")
  throw new Error("A public HTTPS API origin is required");
origin.pathname = "/";
origin.search = "";
origin.hash = "";
const frontendOrigin = "https://dude759.github.io";
async function call(
  path,
  method = "GET",
  body,
  token,
  requestOrigin = frontendOrigin,
  extraHeaders = {},
) {
  const response = await fetch(new URL(path, origin), {
    method,
    signal: AbortSignal.timeout(90000),
    headers: {
      Origin: requestOrigin,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = response.status === 204 ? null : await response.json();
  return {
    status: response.status,
    data,
    cors: response.headers.get("access-control-allow-origin"),
  };
}
const assertions = [];
function pass(name) {
  assertions.push(name);
  console.log(JSON.stringify({ check: name, result: "PASS" }));
}
async function pause(phase, extra = {}) {
  console.log(JSON.stringify({ phase, ...extra }));
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  await new Promise((resolve) => input.once("line", resolve));
  input.close();
}

assert.equal((await call("/health")).data.status, "ok");
assert.equal((await call("/ready")).data.status, "ready");
pass("HTTPS health/readiness");
const catalog = await call("/api/stations?limit=200");
assert.equal(catalog.status, 200);
assert.equal(catalog.cors, frontendOrigin);
assert(catalog.data.items.length >= 8);
assert(
  catalog.data.items.every(
    (s) =>
      s.coordinates.length === 2 &&
      s.coordinates.every(Number.isFinite) &&
      s.loadPercent === null,
  ),
);
assert.equal(
  (
    await call(
      "/api/stations",
      "GET",
      undefined,
      undefined,
      "https://untrusted.example",
    )
  ).status,
  403,
);
pass("PostgreSQL catalog and exact CORS");
const email = `public-smoke-${Date.now()}@example.test`;
const password = randomBytes(24).toString("base64url");
const profile = {
  email,
  name: "Публичная проверка",
  phone: "",
  vehicle: "Учебный EV",
  plate: "",
  connector: "CCS2",
  battery: 65,
};
assert.equal(
  (
    await call("/api/auth/register", "POST", {
      ...profile,
      password,
      role: "operator",
    })
  ).status,
  400,
);
const created = await call("/api/auth/register", "POST", {
  ...profile,
  password,
});
assert.equal(created.status, 201);
assert.equal(created.data.user.role, "driver");
assert.equal(
  (
    await call("/api/auth/register", "POST", {
      ...profile,
      email: email.toUpperCase(),
      password,
    })
  ).status,
  409,
);
assert.equal(
  (
    await call("/api/auth/login", "POST", {
      email,
      password: "invalid-password",
      role: "driver",
    })
  ).status,
  401,
);
const login = await call("/api/auth/login", "POST", {
  email,
  password,
  role: "driver",
});
assert.equal(login.status, 200);
let token = login.data.token;
pass("Registration, duplicate email, role protection, login");
assert.equal(
  (await call("/api/profile", "PATCH", { ...profile, battery: 82 }, token))
    .status,
  200,
);
assert.equal(
  (await call("/api/preferences", "PATCH", { receipts: false }, token)).status,
  200,
);
assert.equal(
  (await call("/api/preferences", "PATCH", { receipts: "invalid" }, token))
    .status,
  400,
);
assert.equal((await call("/api/stations?minPowerKw=-1")).status, 400);
const workspace = (await call("/api/workspace", "GET", undefined, token)).data;
for (const key of ["bookings", "sessions", "payments", "events"])
  assert.deepEqual(workspace[key], []);
assert.equal(workspace.forecast, null);
assert.equal(workspace.stage, "bookings");
assert.equal(
  (await call("/api/operator/network", "PATCH", { networkLimit: 1 }, token))
    .status,
  403,
);
assert.equal((await call("/api/payments", "POST", {}, token)).status, 400);
pass(
  "Profile, preferences, validation, empty workspace and unavailable workflows",
);
const operator = await call("/api/auth/login", "POST", {
  email: "operator@energotransport.test",
  password: "Demo12345",
  role: "operator",
});
assert.equal(operator.status, 200);
assert(!("battery" in operator.data.user));
const operatorWorkspace = (
  await call("/api/workspace", "GET", undefined, operator.data.token)
).data;
assert(operatorWorkspace.stations.length >= 8);
pass("Operator login and database workspace");
if (process.argv.includes("--reservations")) {
  const params = new URLSearchParams({
    start: new Date(Date.now() + 86400000).toISOString(),
    duration: "60",
    connector: "CCS2",
  });
  const path = "/api/stations/tverskaya-plaza/availability?" + params;
  const availability = await call(path, "GET", undefined, token);
  assert.equal(availability.status, 200);
  assert.equal(availability.data.total, 4);
  assert(availability.data.available >= 0 && availability.data.available <= 4);
  assert.equal(availability.data.guaranteed, false);
  assert.equal(availability.data.estimateMethod, "power65-battery30");
  assert.equal(availability.data.currency, "RUB");
  assert.equal(
    availability.data.estimatedAmount,
    availability.data.available ? 442.8 : null,
  );
  assert.equal((await call(path)).status, 401);
  assert.equal(
    (await call(path, "GET", undefined, operator.data.token)).status,
    403,
  );
  assert.equal(
    (await call(path + "&organizationId=spoofed", "GET", undefined, token))
      .status,
    400,
  );
  assert.equal((await call("/api/bookings", "POST", {}, token)).status, 501);
  assert.equal(
    (await call("/api/reservations", "POST", {}, token)).status,
    404,
  );
  pass(
    "Reservation availability, server quote, auth boundaries and no public hold/booking bypass",
  );
}
const isolated = await call("/api/auth/login", "POST", {
  email: "qa.operator@energotransport.test",
  password: "Demo12345",
  role: "operator",
});
assert.equal(isolated.status, 200);
const isolatedWorkspace = await call(
  "/api/workspace",
  "GET",
  undefined,
  isolated.data.token,
);
assert.deepEqual(isolatedWorkspace.data.stations, []);
assert.equal(
  (
    await call(
      "/api/stations/" + catalog.data.items[0].id,
      "GET",
      undefined,
      isolated.data.token,
    )
  ).status,
  404,
);
assert.equal(
  (
    await call(
      "/api/stations/" + catalog.data.items[0].id + "/connectors",
      "GET",
      undefined,
      isolated.data.token,
    )
  ).status,
  404,
);
if (process.argv.includes("--payments")) {
  const body = {
    input: {
      stationId: "tverskaya-plaza",
      connector: "CCS2",
      start: new Date(Date.now() + 7200000).toISOString(),
      duration: 60,
      payment: "card",
    },
  };
  const key = randomUUID();
  // Sequential replay only: concurrency belongs to the isolated PostgreSQL suite.
  const created = [];
  for (let i = 0; i < 2; i++)
    created.push(
      await call("/api/payments", "POST", body, token, frontendOrigin, {
        "Idempotency-Key": key,
      }),
    );
  assert.deepEqual(created.map((r) => r.status).sort(), [200, 201]);
  const first = created[0].data;
  assert.equal(first.id, created[1].data.id);
  assert.equal(first.status, "pending");
  assert.equal(first.reservation.state, "held");
  assert.equal(first.amountKopecks, 44280);
  assert.equal(
    (
      await call(
        "/api/payments",
        "POST",
        { input: { ...body.input, payment: "sbp" } },
        token,
        frontendOrigin,
        { "Idempotency-Key": key },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/api/payments",
        "POST",
        { ...body, amount: 1 },
        token,
        frontendOrigin,
        { "Idempotency-Key": randomUUID() },
      )
    ).status,
    400,
  );
  const otherDriver = await call("/api/auth/login", "POST", {
    email: "driver2@energotransport.test",
    password: "Demo12345",
    role: "driver",
  });
  assert.equal(otherDriver.status, 200);
  assert.equal(
    (
      await call(
        `/api/payments/${first.id}`,
        "GET",
        undefined,
        otherDriver.data.token,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/api/payments/${first.id}`,
        "GET",
        undefined,
        operator.data.token,
      )
    ).status,
    403,
  );
  await call("/api/auth/logout", "POST", undefined, otherDriver.data.token);
  async function outcome(payment, outcome) {
    const url = new URL(payment.confirmationUrl);
    assert.equal(url.protocol, "https:");
    assert.equal(url.origin, origin.origin);
    const page = await fetch(url, {
      signal: AbortSignal.timeout(90000),
      redirect: "error",
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Деньги не списываются/);
    const result = await fetch(new URL(url.pathname, origin), {
      method: "POST",
      signal: AbortSignal.timeout(90000),
      redirect: "error",
      headers: {
        Origin: origin.origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        token: url.searchParams.get("token"),
        outcome,
      }),
    });
    assert.equal(result.status, 200);
  }
  await outcome(first, "failed");
  const failed = await call(
    `/api/payments/${first.id}`,
    "GET",
    undefined,
    token,
  );
  assert.equal(failed.data.status, "failed");
  assert.equal(failed.data.reservation.state, "released");
  const retryKey = randomUUID();
  const retried = await call(
    `/api/payments/${first.id}/retry`,
    "POST",
    {},
    token,
    frontendOrigin,
    { "Idempotency-Key": retryKey },
  );
  assert.equal(retried.status, 200);
  assert.equal(retried.data.attempt.number, 2);
  assert.equal(retried.data.reservation.id, first.reservation.id);
  assert.equal(retried.data.expiresAt, first.expiresAt);
  assert.equal(
    (
      await call(
        `/api/payments/${first.id}/retry`,
        "POST",
        {},
        token,
        frontendOrigin,
        { "Idempotency-Key": retryKey },
      )
    ).data.attempt.id,
    retried.data.attempt.id,
  );
  const cancelled = await call(
    `/api/payments/${first.id}/cancel`,
    "POST",
    {},
    token,
  );
  assert.equal(cancelled.data.status, "cancelled");
  assert.equal(cancelled.data.reservation.state, "released");
  pass(
    "Test payments: idempotent create, owner/role isolation, server price, signed failure, retry and cancel",
  );
  const pending = await call(
    "/api/payments",
    "POST",
    {
      input: {
        ...body.input,
        start: new Date(Date.now() + 45000).toISOString(),
      },
    },
    token,
    frontendOrigin,
    { "Idempotency-Key": randomUUID() },
  );
  assert.equal(pending.status, 201);
  await outcome(pending.data, "succeeded");
  await outcome(pending.data, "succeeded");
  const success = await call(
    `/api/payments/${pending.data.id}`,
    "GET",
    undefined,
    token,
  );
  assert.equal(success.data.status, "succeeded");
  assert.equal(success.data.attempt.status, "succeeded");
  assert.equal(success.data.awaitingFinalization, false);
  assert(success.data.bookingId);
  assert.equal(success.data.reservation.state, "confirmed");
  const paidWorkspace = (await call("/api/workspace", "GET", undefined, token))
    .data;
  const booking = paidWorkspace.bookings.find(
    (b) => b.id === success.data.bookingId,
  );
  assert.equal(booking.paymentId, pending.data.id);
  assert.equal(booking.connectorId, pending.data.reservation.connectorId);
  assert.equal(booking.amount, pending.data.amount);
  assert.equal(
    (await call(`/api/payments/${pending.data.id}/cancel`, "POST", {}, token))
      .status,
    409,
  );
  assert.equal(
    (
      await call(
        "/api/integrations/payments/test/events",
        "POST",
        {},
        undefined,
        frontendOrigin,
        {
          "X-Test-Payment-Timestamp": String(Math.floor(Date.now() / 1000)),
          "X-Test-Payment-Signature": "0".repeat(64),
        },
      )
    ).status,
    401,
  );
  pass(
    "Atomic finalization creates one confirmed booking and survives duplicate success; invalid signatures rejected",
  );
  console.log(
    JSON.stringify({
      phase: "WAITING_ORIGINAL_HOLD_DEADLINE",
      seconds: Math.max(
        0,
        Math.ceil((Date.parse(success.data.expiresAt) - Date.now()) / 1000),
      ),
      fixturePaymentIds: [first.id, pending.data.id],
    }),
  );
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(0, Date.parse(success.data.expiresAt) - Date.now() + 1000),
    ),
  );
  const expired = await call(
    `/api/payments/${pending.data.id}`,
    "GET",
    undefined,
    token,
  );
  assert.equal(expired.data.status, "succeeded");
  assert.equal(expired.data.reconciliationRequired, false);
  assert.equal(expired.data.reservation.state, "confirmed");
  assert.equal(expired.data.bookingId, success.data.bookingId);
  pass(
    "Confirmed booking survives original hold deadline with same immutable snapshot",
  );
  // Delayed success of the already cancelled order must refund, never resurrect its released hold.
  await outcome(first, "succeeded");
  let refunded;
  for (let i = 0; i < 24; i++) {
    refunded = (
      await call(`/api/payments/${first.id}`, "GET", undefined, token)
    ).data;
    if (
      refunded.refunds?.length &&
      refunded.refunds.every((r) => r.status === "succeeded")
    )
      break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(refunded.bookingId, null);
  assert.equal(refunded.reservation.state, "released");
  assert.equal(refunded.providerSuccessReceived, true);
  assert.equal(refunded.refunds.length, 1);
  assert.equal(refunded.refunds[0].status, "succeeded");
  assert(refunded.refunds[0].confirmedAt);
  pass(
    "Late success queues an idempotent compensation and completes only after durable test-adapter receipt",
  );
  if (process.argv.includes("--charging")) {
    const startKey = randomUUID();
    const started = await call(
      "/api/sessions",
      "POST",
      { bookingId: success.data.bookingId },
      token,
      frontendOrigin,
      { "Idempotency-Key": startKey },
    );
    assert.equal(started.status, 202);
    assert.equal(started.data.status, "starting");
    assert.equal(started.data.startConfirmedAt, null);
    const repeated = await call(
      "/api/sessions",
      "POST",
      { bookingId: success.data.bookingId },
      token,
      frontendOrigin,
      { "Idempotency-Key": startKey },
    );
    assert.equal(repeated.data.id, started.data.id);
    let session;
    for (let i = 0; i < 35; i++) {
      const read = await call(
        `/api/sessions/${started.data.id}`,
        "GET",
        undefined,
        token,
      );
      assert.equal(read.status, 200);
      session = read.data;
      if (session.status === "active" && session.energyWh > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(session.status, "active");
    assert(session.startConfirmedAt);
    assert(session.energyWh > 0);
    assert.equal(session.source, "simulator");
    assert.equal(session.soc, null);
    assert.equal(session.initialCharge, null);
    assert.equal(session.telemetry.source, "simulator");
    assert.equal(
      (
        await call(
          `/api/sessions/${session.id}`,
          "GET",
          undefined,
          isolated.data.token,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          `/api/sessions/${session.id}`,
          "GET",
          undefined,
          operator.data.token,
        )
      ).status,
      200,
    );
    pass(
      "Server start awaits adapter, repeated key reuses session, measured simulator energy advances and role scope is enforced",
    );
    const stopKey = randomUUID();
    const stopping = await call(
      `/api/sessions/${session.id}/stop`,
      "POST",
      {},
      token,
      frontendOrigin,
      { "Idempotency-Key": stopKey },
    );
    assert([200, 202].includes(stopping.status));
    for (let i = 0; i < 30; i++) {
      session = (
        await call(`/api/sessions/${session.id}`, "GET", undefined, token)
      ).data;
      if (
        session.status === "completed" &&
        (!session.refund || session.refund.status === "succeeded")
      )
        break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(session.status, "completed");
    assert(session.endedAt);
    assert(session.settlement);
    assert(Number.isInteger(session.settlement.finalCostKopecks));
    assert.equal(
      session.settlement.finalCostKopecks,
      Math.ceil((session.energyWh * session.tariffKopecks) / 1000),
    );
    assert.equal(
      session.settlement.finalCostKopecks + session.settlement.unusedKopecks,
      session.prepaidKopecks,
    );
    assert(session.settlement.finalCostKopecks <= session.prepaidKopecks);
    assert.equal(session.refund.status, "succeeded");
    assert(session.refund.confirmedAt);
    assert.equal(
      session.refund.amountKopecks,
      session.settlement.unusedKopecks,
    );
    const stopped = await call(
      `/api/sessions/${session.id}/stop`,
      "POST",
      {},
      token,
      frontendOrigin,
      { "Idempotency-Key": stopKey },
    );
    assert.deepEqual(stopped.data.settlement, session.settlement);
    pass(
      "Acknowledged stop fixes measured Wh, immutable kopeck settlement and separate confirmed remainder refund",
    );
    const reentered = await call("/api/auth/login", "POST", {
      email,
      password,
      role: "driver",
    });
    assert.equal(reentered.status, 200);
    const history = (
      await call("/api/workspace", "GET", undefined, reentered.data.token)
    ).data;
    assert.equal(history.charging, true);
    assert.equal(
      history.sessions.find((s) => s.id === session.id).status,
      "completed",
    );
    assert.equal(
      history.bookings.find((b) => b.id === success.data.bookingId).status,
      "used",
    );
    await call("/api/auth/logout", "POST", undefined, reentered.data.token);
    console.log(
      JSON.stringify({
        phase: "CHARGING_FIXTURE_COMPLETED",
        sessionId: session.id,
        bookingId: success.data.bookingId,
        energyWh: session.energyWh,
        finalCostKopecks: session.settlement.finalCostKopecks,
        refundKopecks: session.refund.amountKopecks,
      }),
    );
    pass(
      "Completed charging and confirmed refund survive a new login in persistent workspace history",
    );
  }
}
await call("/api/auth/logout", "POST", undefined, isolated.data.token);
await call("/api/auth/logout", "POST", undefined, operator.data.token);
pass("Public organization isolation");

if (process.argv.includes("--interactive")) {
  await pause("READY_FOR_RESTART", { fixtureEmail: email });
  assert.equal(
    (await call("/api/auth/me", "GET", undefined, token)).data.battery,
    82,
  );
  assert.equal(
    (await call("/api/workspace", "GET", undefined, token)).data.preferences
      .receipts,
    false,
  );
  pass("Existing token, profile and preferences survive service redeploy");
  await pause("READY_FOR_EXPIRY", { fixtureEmail: email });
  assert.equal(
    (await call("/api/auth/me", "GET", undefined, token)).status,
    401,
  );
  pass("Expired public token is rejected");
  token = (
    await call("/api/auth/login", "POST", { email, password, role: "driver" })
  ).data.token;
}
assert.equal(
  (await call("/api/auth/logout", "POST", undefined, token)).status,
  204,
);
assert.equal((await call("/api/auth/me", "GET", undefined, token)).status, 401);
pass("Public logout revokes token");
console.log(
  JSON.stringify({
    result: "PASS",
    checks: assertions,
    fixtureEmail: email,
    apiOrigin: origin.origin,
  }),
);
