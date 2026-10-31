// Sequential public teaching acceptance only. Fault/race/time manipulation belongs in local PG17 tests.
// Run from repository root. Fixture contains IDs only, never bearer/capability tokens.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const origin = new URL(process.argv[2]);
if (origin.protocol !== "https:") throw new Error("Public HTTPS required");
const phase = process.argv[3],
  fixture = "artifacts/stage5b-public-fixture.json",
  evidence = "artifacts/stage5b-public-dispatch.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(path, method = "GET", body, token, key) {
  const r = await fetch(new URL("/api" + path, origin), {
    method,
    signal: AbortSignal.timeout(90000),
    headers: {
      Origin: "https://dude759.github.io",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = r.status === 204 ? null : await r.json();
  if (!r.ok)
    throw new Error(`${method} ${path}: ${r.status} ${data?.message ?? ""}`);
  return data;
}
const tokens = [];
async function login(email, role) {
  const r = await call("/auth/login", "POST", {
    email,
    password: "Demo12345",
    role,
  });
  tokens.push(r.token);
  return r.token;
}
async function poll(fn, check) {
  let value;
  for (let i = 0; i < 40; i++) {
    value = await fn();
    if (check(value)) return value;
    await sleep(1000);
  }
  throw new Error("Acceptance state not reached");
}
function save(label, value) {
  let old = [];
  try {
    old = JSON.parse(readFileSync(evidence, "utf8"));
  } catch {}
  old.push({ label, at: new Date().toISOString(), ...value });
  writeFileSync(evidence, JSON.stringify(old, null, 2));
  console.log(
    JSON.stringify({ phase: label, result: "PASS", ...(value.summary ?? {}) }),
  );
}
const op = await login("operator@energotransport.test", "operator");
const drivers = [
  await login("driver@energotransport.test", "driver"),
  await login("driver2@energotransport.test", "driver"),
];
try {
  if (phase === "prepare") {
    const initial = await call(
      "/operator/power/dispatch",
      "GET",
      undefined,
      op,
    );
    assert.equal(initial.enabled, false);
    assert.equal(initial.sessions.length, 0);
    const grid = await call("/operator/grid", "GET", undefined, op);
    const f = {
      original: { scenario: grid.scenario, workload: grid.workload },
      bookings: [],
      start: new Date(Date.now() + 45000).toISOString(),
    };
    writeFileSync(fixture, JSON.stringify(f));
    const catalog = await call("/stations");
    const stations = catalog.items
      .filter(
        (s) =>
          s.status === "available" &&
          s.connectors.some((c) => c.type === "CCS2" && c.available > 0),
      )
      .filter((s) => s.id !== "tverskaya-plaza")
      .slice(0, 2);
    assert.equal(stations.length, 2);
    for (let i = 0; i < 2; i++) {
      const p = await call(
        "/payments",
        "POST",
        {
          input: {
            stationId: stations[i].id,
            connector: "CCS2",
            start: f.start,
            duration: 30,
            payment: "card",
          },
        },
        drivers[i],
        randomUUID(),
      );
      const u = new URL(p.confirmationUrl);
      assert.equal(u.origin, origin.origin);
      const r = await fetch(new URL(u.pathname, origin), {
        method: "POST",
        signal: AbortSignal.timeout(90000),
        headers: {
          Origin: origin.origin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          token: u.searchParams.get("token"),
          outcome: "succeeded",
        }),
      });
      assert.equal(r.status, 200);
      const paid = await call(
        "/payments/" + p.id,
        "GET",
        undefined,
        drivers[i],
      );
      assert(paid.bookingId);
      f.bookings.push({
        id: paid.bookingId,
        paymentId: paid.id,
        stationId: stations[i].id,
      });
      writeFileSync(fixture, JSON.stringify(f));
    }
    await call(
      "/operator/grid/scenario",
      "POST",
      { scenario: "normal", workload: "live" },
      op,
      randomUUID(),
    );
    const enabled = await call(
      "/operator/power/dispatch",
      "POST",
      { enabled: true },
      op,
      randomUUID(),
    );
    assert.equal(enabled.enabled, true);
    save("PREPARED", { summary: { bookings: f.bookings, start: f.start } });
  } else {
    const f = JSON.parse(readFileSync(fixture, "utf8"));
    if (phase === "start") {
      const wait = Date.parse(f.start) - Date.now();
      if (wait > 0) await sleep(Math.min(wait + 200, 45000));
      for (let i = 0; i < f.bookings.length; i++) {
        const s = await call(
          "/sessions",
          "POST",
          { bookingId: f.bookings[i].id },
          drivers[i],
          randomUUID(),
        );
        f.bookings[i].sessionId = s.id;
        writeFileSync(fixture, JSON.stringify(f));
        await poll(
          () => call("/sessions/" + s.id, "GET", undefined, drivers[i]),
          (s) => s.status === "active",
        );
      }
      save("STARTED", {
        summary: { sessions: f.bookings.map((b) => b.sessionId) },
      });
    } else if (phase === "finish") {
      const results = [];
      for (let i = 0; i < f.bookings.length; i++) {
        const b = f.bookings[i];
        const workspace = await call(
          "/workspace",
          "GET",
          undefined,
          drivers[i],
        );
        const own = workspace.sessions.find((s) => s.bookingId === b.id);
        if (!own) {
          await call(
            "/bookings/" + b.id + "/cancel",
            "POST",
            {},
            drivers[i],
            randomUUID(),
          );
          continue;
        }
        await call(
          "/sessions/" + own.id + "/stop",
          "POST",
          {},
          drivers[i],
          randomUUID(),
        );
        const done = await poll(
          () => call("/sessions/" + own.id, "GET", undefined, drivers[i]),
          (s) =>
            s.status === "completed" &&
            (!s.refund || s.refund.status === "succeeded"),
        );
        assert.equal(
          done.settlement.finalCostKopecks,
          Math.ceil((done.energyWh * done.tariffKopecks) / 1000),
        );
        assert.equal(
          done.settlement.finalCostKopecks + done.settlement.unusedKopecks,
          done.prepaidKopecks,
        );
        if (done.refund)
          assert.equal(
            done.refund.amountKopecks,
            done.settlement.unusedKopecks,
          );
        results.push(done);
      }
      await poll(
        () => call("/operator/power/dispatch", "GET", undefined, op),
        (d) => d.sessions.length === 0,
      );
      // Pending superseded commands are reconciled by the worker before switching OFF.
      let off;
      for (let i = 0; i < 20; i++) {
        try {
          off = await call(
            "/operator/power/dispatch",
            "POST",
            { enabled: false },
            op,
            randomUUID(),
          );
          break;
        } catch (e) {
          if (i === 19) throw e;
          await sleep(1000);
        }
      }
      assert.equal(off.enabled, false);
      await call(
        "/operator/grid/scenario",
        "POST",
        f.original,
        op,
        randomUUID(),
      );
      save("COMPLETED_AND_RESTORED", {
        sessions: results,
        summary: {
          sessions: results.map((s) => ({
            id: s.id,
            energyWh: s.energyWh,
            cost: s.settlement.finalCostKopecks,
            refund: s.refund?.amountKopecks,
          })),
          mode: "OFF",
          grid: f.original,
        },
      });
    } else {
      const w = Number(process.argv[4]);
      if (!Number.isInteger(w) || w < 0)
        throw new Error("Expected acknowledged watts required");
      const view = await poll(
        () => call("/operator/power/dispatch", "GET", undefined, op),
        (d) =>
          d.sessions.length === 2 &&
          d.sessions.every(
            (s) =>
              s.acknowledgedW === w &&
              s.measuredW === w &&
              s.command?.status !== "pending" &&
              s.command?.status !== "submitted",
          ),
      );
      assert.deepEqual(
        view.sessions.map((s) => s.id).sort(),
        f.bookings.map((b) => b.sessionId).sort(),
      );
      const sessions = [];
      for (let i = 0; i < 2; i++)
        sessions.push(
          await call(
            "/sessions/" + f.bookings[i].sessionId,
            "GET",
            undefined,
            drivers[i],
          ),
        );
      for (const s of sessions) {
        assert(s.energyWh <= s.energyBudgetWh);
        assert.equal(s.powerControl.acknowledgedW, w);
        assert.equal(s.source, "simulator");
      }
      const monitor = await call("/operator/monitoring", "GET", undefined, op);
      assert.equal(monitor.measuredPowerW, 2 * w);
      save(phase, {
        view,
        sessions,
        monitor,
        summary: {
          acknowledgedW: view.sessions.map((s) => s.acknowledgedW),
          measuredW: view.sessions.map((s) => s.measuredW),
          energyWh: sessions.map((s) => s.energyWh),
        },
      });
    }
  }
} finally {
  for (const token of tokens)
    await call("/auth/logout", "POST", undefined, token).catch(() => {});
}
