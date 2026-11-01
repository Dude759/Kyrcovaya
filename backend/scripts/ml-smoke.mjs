import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const base = new URL(process.argv[2]);
if (base.protocol !== "https:")
  throw new Error("Explicit HTTPS API origin required");
base.pathname = "/";
base.search = "";
base.hash = "";
const bundle = JSON.parse(
  await readFile(
    new URL("../assets/demo-forecast.json", import.meta.url),
    "utf8",
  ),
);
const tokens = [];
async function call(path, method = "GET", body, token) {
  const response = await fetch(new URL(path, base), {
    method,
    signal: AbortSignal.timeout(90000),
    headers: {
      Origin: "https://dude759.github.io",
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    data: response.status === 204 ? null : await response.json(),
  };
}
const checks = [];
const pass = (x) => {
  checks.push(x);
  console.log(JSON.stringify({ check: x, result: "PASS" }));
};
async function login(role) {
  const r = await call("/api/auth/login", "POST", {
    email: role + "@energotransport.test",
    password: "Demo12345",
    role,
  });
  assert.equal(r.status, 200);
  tokens.push(r.data.token);
  return r.data.token;
}
try {
  assert.equal((await call("/api/operator/forecast/demo")).status, 401);
  const operator = await login("operator");
  const real = await call("/api/operator/forecast", "GET", null, operator);
  assert.equal(real.status, 200);
  assert.equal(real.data.forecast, null);
  assert.equal(real.data.source, "actual");
  assert.equal(real.data.readiness, "NEEDS_MORE_DATA");
  pass("actual NEEDS_MORE_DATA, no synthetic disguised as actual");
  const replay = await call(
    "/api/operator/forecast/demo",
    "GET",
    null,
    operator,
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.data.historical, true);
  assert.equal(replay.data.staleForCurrentNetwork, true);
  assert.deepEqual(replay.data.forecast, bundle);
  pass(
    "24 Python RF replay points, source/version/origin/metrics match trusted artifact",
  );
  assert.equal(replay.data.forecast.points.length, 24);
  for (const [i, p] of replay.data.forecast.points.entries()) {
    assert.equal(p.h, i + 1);
    assert.equal(
      Date.parse(p.time),
      Date.parse(bundle.origin) + (i + 1) * 3600000,
    );
    assert(Number.isFinite(p.powerKw) && p.powerKw >= 0);
  }
  assert.equal(
    (await call("/api/workspace", "GET", null, operator)).data.forecast,
    null,
  );
  pass("historical dates/units and workspace.actual null");
  assert.equal(
    (
      await call(
        "/api/operator/forecast?organizationId=other",
        "GET",
        null,
        operator,
      )
    ).status,
    400,
  );
  assert.equal(
    (await call("/api/operator/forecast", "POST", {}, operator)).status,
    501,
  );
  pass("strict input; no dynamic calculation or jobs");
  const driver = await login("driver");
  for (const path of ["/api/operator/forecast", "/api/operator/forecast/demo"])
    assert.equal((await call(path, "GET", null, driver)).status, 403);
  pass("unauthenticated and driver refused");
  await call("/api/auth/logout", "POST", {}, operator);
  const again = await login("operator");
  assert.deepEqual(
    (await call("/api/operator/forecast/demo", "GET", null, again)).data
      .forecast,
    bundle,
  );
  pass("logout/relogin preserves immutable result");
  console.log(
    JSON.stringify({
      result: "PASS",
      passed: checks.length,
      mode: "historical_replay",
      modelVersion: bundle.modelVersion,
      origin: bundle.origin,
      sha256: createHash("sha256").update(JSON.stringify(bundle)).digest("hex"),
    }),
  );
} finally {
  for (const token of tokens)
    await call("/api/auth/logout", "POST", {}, token).catch(() => {});
}
