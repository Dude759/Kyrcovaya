import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
) {
  const response = await fetch(new URL(path, origin), {
    method,
    signal: AbortSignal.timeout(90000),
    headers: {
      Origin: requestOrigin,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
assert.equal(workspace.stage, "foundation");
assert.equal(
  (await call("/api/operator/network", "PATCH", { networkLimit: 1 }, token))
    .status,
  403,
);
assert.equal((await call("/api/payments", "POST", {}, token)).status, 501);
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
