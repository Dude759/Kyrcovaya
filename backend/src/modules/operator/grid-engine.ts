export type Demand = {
  id: string;
  stationId: string;
  requestedW: number;
  portLimitW: number;
  stationLimitW: number;
};
function watts(v: number) {
  if (!Number.isSafeInteger(v) || v < 0 || v > 1e12)
    throw new Error("Nonnegative integer watts required");
  return v;
}
export function maxMin(demands: Demand[], budgetW: number) {
  watts(budgetW);
  const ids = new Set<string>(),
    limits = new Map<string, number>();
  const rows = demands
    .map((d) => {
      if (ids.has(d.id)) throw new Error("Duplicate session");
      ids.add(d.id);
      for (const v of [d.requestedW, d.portLimitW, d.stationLimitW]) watts(v);
      if (
        limits.has(d.stationId) &&
        limits.get(d.stationId) !== d.stationLimitW
      )
        throw new Error("Inconsistent station limit");
      limits.set(d.stationId, d.stationLimitW);
      return { ...d, plannedW: 0, cap: Math.min(d.requestedW, d.portLimitW) };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Map<string, number>();
  let left = budgetW;
  while (left > 0) {
    const live = rows.filter(
      (d) =>
        d.plannedW < d.cap &&
        (used.get(d.stationId) ?? 0) < limits.get(d.stationId)!,
    );
    if (!live.length) break;
    const counts = new Map<string, number>();
    for (const d of live)
      counts.set(d.stationId, (counts.get(d.stationId) ?? 0) + 1);
    let step = Math.floor(left / live.length);
    for (const d of live)
      step = Math.min(
        step,
        d.cap - d.plannedW,
        Math.floor(
          (limits.get(d.stationId)! - (used.get(d.stationId) ?? 0)) /
            counts.get(d.stationId)!,
        ),
      );
    if (step > 0) {
      for (const d of live) {
        d.plannedW += step;
        used.set(d.stationId, (used.get(d.stationId) ?? 0) + step);
        left -= step;
      }
    } else {
      let changed = false;
      for (const d of live)
        if (
          left > 0 &&
          (used.get(d.stationId) ?? 0) < limits.get(d.stationId)!
        ) {
          d.plannedW++;
          left--;
          used.set(d.stationId, (used.get(d.stationId) ?? 0) + 1);
          changed = true;
        }
      if (!changed) break;
    }
  }
  return rows.map(({ cap, ...r }) => r);
}
export type GridReading = {
  availablePowerKw: number | null;
  baseLoadKw: number | null;
  status: "online" | "offline";
  receivedAt: string | null;
  source: "simulator";
};
export function gridBudget(
  r: GridReading,
  operatorLimitW: number,
  now: Date,
  ttlSeconds: number,
) {
  watts(operatorLimitW);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 5 || ttlSeconds > 3600)
    throw new Error("Invalid freshness threshold");
  if (r.status === "offline") return { budgetW: null, validity: "offline" };
  if (r.availablePowerKw === null || r.baseLoadKw === null || !r.receivedAt)
    return { budgetW: null, validity: "missing" };
  const available = r.availablePowerKw * 1000,
    base = r.baseLoadKw * 1000,
    age = now.getTime() - Date.parse(r.receivedAt);
  if (
    !Number.isSafeInteger(available) ||
    available < 0 ||
    !Number.isSafeInteger(base) ||
    base < 0 ||
    !Number.isFinite(age) ||
    age < 0
  )
    return { budgetW: null, validity: "invalid" };
  if (age > ttlSeconds * 1000) return { budgetW: null, validity: "stale" };
  return {
    budgetW: Math.max(0, Math.min(operatorLimitW, available - base)),
    validity: "fresh",
  };
}
export const scenarios = [
  "normal",
  "deficit",
  "deep_deficit",
  "recovery",
  "offline",
  "stale",
  "missing",
] as const;
export type Scenario = (typeof scenarios)[number];
export interface GridAdapter {
  read(scenario: Scenario, now: Date, ttlSeconds: number): GridReading;
}
export class SimulatorGridAdapter implements GridAdapter {
  read(scenario: Scenario, now: Date, ttlSeconds: number): GridReading {
    return {
      availablePowerKw:
        scenario === "missing" || scenario === "offline"
          ? null
          : scenario === "deficit"
            ? 250
            : scenario === "deep_deficit"
              ? 120
              : 500,
      baseLoadKw: scenario === "missing" || scenario === "offline" ? null : 100,
      status: scenario === "offline" ? "offline" : "online",
      receivedAt:
        scenario === "missing"
          ? null
          : new Date(
              now.getTime() -
                (scenario === "stale" ? (ttlSeconds + 1) * 1000 : 0),
            ).toISOString(),
      source: "simulator",
    };
  }
}
