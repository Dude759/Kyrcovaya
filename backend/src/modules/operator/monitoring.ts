import type { PoolClient } from "pg";
import { HttpError } from "../../middleware/errors.js";
const num = (v: any) => (v == null ? null : Number(v));
const iso = (v: any) => (v ? new Date(v).toISOString() : null);
export function monitoredSession(s: any, now: Date) {
  const age = s.sampled_at
    ? now.getTime() - new Date(s.sampled_at).getTime()
    : null;
  const telemetry =
    s.online === false
      ? "offline"
      : age === null
        ? "missing"
        : age < 0 || age > 60000
          ? "stale"
          : "fresh";
  return {
    id: s.id,
    stationId: s.station_id,
    stationName: s.station_name,
    connectorId: s.connector_id,
    connectorLabel: s.label,
    connectorType: s.connector_type,
    status: s.status,
    requestedAt: iso(s.requested_at),
    startedAt: iso(s.started_at),
    endedAt: iso(s.ended_at),
    allocatedPowerW: Number(s.allocated_power_w),
    currentPowerW:
      telemetry === "fresh" && ["active", "stopping"].includes(s.status)
        ? num(s.power_w)
        : null,
    lastPowerW: num(s.power_w),
    knownEnergyWh: num(s.measured_energy_wh),
    lastMeasuredAt: iso(s.sampled_at),
    ageSeconds: age === null ? null : Math.max(0, Math.floor(age / 1000)),
    telemetry,
    gap: s.gap ?? false,
    telemetryGap: s.telemetry_gap,
    source: "simulator",
    finalCostKopecks: num(s.final_cost_kopecks),
  };
}
export const monitoredSelect = `SELECT s.*, st.name AS station_name,c.label,d.online,m.sampled_at,m.energy_wh AS measured_energy_wh,m.power_w,m.gap,x.final_cost_kopecks
 FROM charging_sessions s JOIN stations st ON st.id=s.station_id JOIN connectors c ON c.id=s.connector_id
 LEFT JOIN simulator_devices d ON d.connector_id=s.connector_id
 LEFT JOIN LATERAL(SELECT * FROM session_measurements WHERE session_id=s.id ORDER BY sequence_no DESC LIMIT 1)m ON true
 LEFT JOIN session_settlements x ON x.session_id=s.id`;
export function measuredSubset(
  sessions: ReturnType<typeof monitoredSession>[],
) {
  const known = sessions.filter((s) => s.currentPowerW !== null),
    total = known.reduce((n, s) => n + s.currentPowerW!, 0);
  const complete = sessions.length > 0 && known.length === sessions.length;
  return {
    measuredPowerW: complete ? total : null,
    measuredSubsetPowerW: known.length ? total : null,
    measuredSessions: known.length,
    expectedSessions: sessions.length,
    complete,
    allocatedPowerW: sessions.reduce((n, s) => n + s.allocatedPowerW, 0),
    telemetryCounts: Object.fromEntries(
      ["fresh", "missing", "stale", "offline"].map((k) => [
        k,
        sessions.filter((s) => s.telemetry === k).length,
      ]),
    ),
  };
}
export async function ownStation(db: PoolClient, org: string, id: string) {
  const s = (
    await db.query(
      "SELECT * FROM stations WHERE id=$1 AND organization_id=$2",
      [id, org],
    )
  ).rows[0];
  if (!s) throw new HttpError(404, "Станция не найдена.");
  return s;
}
export async function monitoringSnapshot(
  db: PoolClient,
  org: string,
  stationId?: string,
) {
  if (stationId) await ownStation(db, org, stationId);
  const now = (await db.query("SELECT clock_timestamp() AS now")).rows[0].now;
  const live = (
    await db.query(
      monitoredSelect +
        ` WHERE s.organization_id=$1 AND ($2::text IS NULL OR s.station_id=$2) AND s.status IN ('starting','active','stopping') ORDER BY s.requested_at,s.id`,
      [org, stationId ?? null],
    )
  ).rows.map((s) => monitoredSession(s, now));
  const stations = (
    await db.query(
      `SELECT st.id,st.name,st.operating_state,st.archived_at,st.limit_kw,st.max_power_kw,
    (SELECT max(m.sampled_at) FROM charging_sessions s JOIN session_measurements m ON m.session_id=s.id WHERE s.station_id=st.id) AS last_measured_at
    FROM stations st WHERE st.organization_id=$1 AND ($2::text IS NULL OR st.id=$2) AND (st.archived_at IS NULL OR st.id=$2) ORDER BY st.name,st.id`,
      [org, stationId ?? null],
    )
  ).rows;
  const stats = (
    await db.query(
      `SELECT s.station_id,s.status,count(*)::int AS count,sum(m.energy_wh) AS known_energy_wh,sum(x.final_cost_kopecks) FILTER (WHERE s.status='completed') AS cost
    FROM charging_sessions s LEFT JOIN LATERAL(SELECT energy_wh FROM session_measurements WHERE session_id=s.id ORDER BY sequence_no DESC LIMIT 1)m ON true
    LEFT JOIN session_settlements x ON x.session_id=s.id WHERE s.organization_id=$1 AND ($2::text IS NULL OR s.station_id=$2) GROUP BY s.station_id,s.status`,
      [org, stationId ?? null],
    )
  ).rows;
  const counts = (rows: any[]) =>
    Object.fromEntries(
      ["starting", "active", "stopping", "completed", "failed"].map((k) => [
        k,
        rows.filter((r) => r.status === k).reduce((n, r) => n + r.count, 0),
      ]),
    );
  const known = stats.filter((r) => r.known_energy_wh !== null);
  const result = {
    asOf: now.toISOString(),
    source: "simulator",
    scope: "simulated_charging_sessions",
    gridBudgetKw: null,
    gridReserveKw: null,
    sessionCounts: counts(stats),
    knownEnergyWh: known.length
      ? known.reduce((n, r) => n + Number(r.known_energy_wh), 0)
      : null,
    completedTestCostKopecks: stats.reduce(
      (n, r) => n + Number(r.cost ?? 0),
      0,
    ),
    ...measuredSubset(live),
    stations: stations.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.operating_state,
      archivedAt: iso(s.archived_at),
      localLimitKw: Number(s.limit_kw),
      physicalMaxKw: Number(s.max_power_kw),
      lastMeasuredAt: iso(s.last_measured_at),
      sessionCounts: counts(stats.filter((r) => r.station_id === s.id)),
      ...measuredSubset(live.filter((x) => x.stationId === s.id)),
    })),
    sessions: live,
  };
  return result;
}
export function historyDto(r: any) {
  return {
    stationId: r.station_id,
    stationName: r.station_name,
    intervalStart: iso(r.interval_start),
    intervalEnd: iso(r.interval_end),
    measuredEnergyWh: num(r.measured_energy_wh),
    averagePowerW: num(r.average_power_w),
    measuredSubsetAverageW: num(r.measured_subset_average_w),
    activeSessions: r.active_sessions,
    localLimitKw: Number(r.local_limit_kw),
    source: r.source,
    quality: r.quality,
    observedMs: Number(r.observed_ms),
    coveredSessionMs: Number(r.covered_session_ms),
    expectedSessionMs: Number(r.expected_session_ms),
    sampleCount: r.sample_count,
    gapCount: r.gap_count,
    boundaryCount: r.boundary_count,
    unattributedEnergyWh: Number(r.unattributed_energy_wh),
    firstSampleAt: iso(r.first_sample_at),
    lastSampleAt: iso(r.last_sample_at),
    builtAt: iso(r.built_at),
    rule: r.rule,
  };
}
