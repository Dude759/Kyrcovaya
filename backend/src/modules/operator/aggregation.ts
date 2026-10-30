import type { Database } from "../../db/pool.js";
import { transaction } from "../../db/pool.js";
export const HOUR = 3600000;
export const MAX_SEGMENT_MS = 15000;
const ms = (v: any): number => new Date(v).getTime();
const hour = (v: number) => Math.floor(v / HOUR) * HOUR;
function unionLength(spans: number[][]) {
  let total = 0,
    end = -Infinity;
  for (const [a, b] of spans.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}
// Conservative: no interpolation. Only adjacent readings <=15s, no gap, within one UTC hour.
// Boundary/gap deltas remain known but unattributed; they never become hourly energy.
export function aggregateHours(
  stations: any[],
  sessions: any[],
  readings: any[],
  from: Date,
  to: Date,
) {
  const buckets = new Map<string, any>();
  const get = (sid: string, t: number) => buckets.get(sid + "|" + hour(t));
  for (const s of stations)
    for (
      let t = hour(Math.max(ms(from), ms(s.created_at)));
      t < ms(to);
      t += HOUR
    ) {
      const expected = sessions.filter(
        (x) =>
          x.station_id === s.id &&
          x.started_at &&
          ms(x.started_at) < t + HOUR &&
          ms(x.ended_at ?? to) > t,
      );
      const expectedMs = expected.reduce(
        (sum, x) =>
          sum +
          Math.max(
            0,
            Math.min(t + HOUR, ms(x.ended_at ?? to)) -
              Math.max(t, ms(x.started_at)),
          ),
        0,
      );
      buckets.set(s.id + "|" + t, {
        station_id: s.id,
        organization_id: s.organization_id,
        interval_start: new Date(t).toISOString(),
        interval_end: new Date(t + HOUR).toISOString(),
        local_limit_kw: Number(s.limit_kw),
        active_sessions: expected.length,
        expected_session_ms: expectedMs,
        covered_session_ms: 0,
        sample_count: 0,
        gap_count: 0,
        boundary_count: 0,
        unattributed_energy_wh: 0,
        first_sample_at: null,
        last_sample_at: null,
        spans: [],
        energy: 0,
      });
    }
  const previous = new Map<string, any>();
  for (const r of [...readings].sort(
    (a, b) =>
      a.session_id.localeCompare(b.session_id) ||
      Number(a.sequence_no) - Number(b.sequence_no),
  )) {
    const t = ms(r.sampled_at),
      sampleBucket = get(r.station_id, t),
      p = previous.get(r.session_id);
    previous.set(r.session_id, r);
    if (t < ms(from) || t > ms(to)) continue;
    const iso = new Date(t).toISOString();
    const note = (b: any) => {
      b.sample_count++;
      if (!b.first_sample_at || iso < b.first_sample_at)
        b.first_sample_at = iso;
      if (!b.last_sample_at || iso > b.last_sample_at) b.last_sample_at = iso;
    };
    if (sampleBucket) note(sampleBucket);
    if (!p) {
      if (r.gap && sampleBucket) sampleBucket.gap_count++;
      continue;
    }
    const start = ms(p.sampled_at),
      elapsed = t - start,
      delta = Number(r.energy_wh) - Number(p.energy_wh);
    // A right endpoint exactly at HH:00 belongs to the preceding segment/hour.
    const b = get(r.station_id, t > start && t % HOUR === 0 ? t - 1 : t);
    if (!b || start < ms(from)) continue;
    if (b !== sampleBucket) note(b);
    const broken =
      r.gap ||
      elapsed > MAX_SEGMENT_MS ||
      elapsed <= 0 ||
      Number(r.sequence_no) !== Number(p.sequence_no) + 1;
    const boundary = hour(start) !== hour(t - 1);
    if (broken) b.gap_count++;
    if (boundary) b.boundary_count++;
    if (broken || boundary) {
      b.unattributed_energy_wh += Math.max(0, delta);
      continue;
    }
    b.spans.push([start, t]);
    b.covered_session_ms += elapsed;
    b.energy += delta;
  }
  return [...buckets.values()].map((b) => {
    const observed = unionLength(b.spans);
    const complete =
      observed === HOUR &&
      b.covered_session_ms >= b.expected_session_ms &&
      b.gap_count === 0 &&
      b.boundary_count === 0 &&
      ms(b.interval_end) <= ms(to);
    const { spans, energy, ...row } = b;
    return {
      ...row,
      observed_ms: observed,
      measured_energy_wh: observed ? energy : null,
      average_power_w: complete ? energy : null,
      measured_subset_average_w: observed
        ? Math.round(((energy * HOUR) / observed) * 1000) / 1000
        : null,
      quality: complete
        ? "complete"
        : b.sample_count || observed
          ? "partial"
          : "missing",
      source: "simulator",
      rule: "strict-adjacent-v1",
    };
  });
}

export async function buildPowerHistory(
  pool: Database,
  range?: { from: Date; to: Date },
) {
  return transaction(pool, async (db) => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    if (
      !(await db.query("SELECT pg_try_advisory_xact_lock(734208,1) AS locked"))
        .rows[0].locked
    )
      return 0;
    const now = (await db.query("SELECT clock_timestamp() AS now")).rows[0].now;
    const to = range?.to ?? now,
      from = range?.from ?? new Date(hour(ms(now)) - 47 * HOUR);
    if (ms(to) <= ms(from) || ms(to) - ms(from) > 48 * HOUR || ms(to) > ms(now))
      throw new Error("History range must be past and at most 48 hours");
    const stations = (
      await db.query(
        "SELECT id,organization_id,created_at,limit_kw FROM stations WHERE created_at<$1 AND (archived_at IS NULL OR archived_at>=$2)",
        [to, from],
      )
    ).rows;
    const sessions = (
      await db.query(
        "SELECT id,station_id,started_at,ended_at FROM charging_sessions WHERE requested_at<$1 AND (ended_at IS NULL OR ended_at>=$2)",
        [to, from],
      )
    ).rows;
    const readings = (
      await db.query(
        `SELECT m.*,s.station_id FROM session_measurements m JOIN charging_sessions s ON s.id=m.session_id WHERE m.sampled_at >= $1::timestamptz-interval '15 seconds' AND m.sampled_at<=$2 ORDER BY m.session_id,m.sequence_no`,
        [from, to],
      )
    ).rows;
    const rows = aggregateHours(stations, sessions, readings, from, to);
    // Historical limit at the bucket's beginning, reconstructed from the immutable operator audit.
    const limits = (
      await db.query(
        `SELECT s.id AS station_id,g.t AS interval_start,COALESCE(
      (SELECT (e.after_data->>'limitKw')::numeric FROM network_events e WHERE e.station_id=s.id AND e.action IN ('station_created','station_updated') AND e.created_at<=greatest(g.t,s.created_at) ORDER BY e.created_at DESC,e.id DESC LIMIT 1),
      (SELECT COALESCE((e.before_data->>'limitKw')::numeric,(e.after_data->>'limitKw')::numeric) FROM network_events e WHERE e.station_id=s.id AND e.action IN ('station_created','station_updated') AND e.created_at>greatest(g.t,s.created_at) ORDER BY e.created_at,e.id LIMIT 1),s.limit_kw) AS limit_kw
      FROM stations s CROSS JOIN generate_series(date_trunc('hour',$1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',$2::timestamptz,interval '1 hour') g(t) WHERE s.created_at<$2`,
        [from, to],
      )
    ).rows;
    const map = new Map(
      limits.map((r) => [
        r.station_id + "|" + ms(r.interval_start),
        Number(r.limit_kw),
      ]),
    );
    for (const r of rows)
      r.local_limit_kw =
        map.get(r.station_id + "|" + ms(r.interval_start)) ?? r.local_limit_kw;
    if (!rows.length) return 0;
    const columns = Object.keys(rows[0]);
    const types: Record<string, string> = {
      station_id: "text",
      organization_id: "uuid",
      interval_start: "timestamptz",
      interval_end: "timestamptz",
      quality: "text",
      source: "text",
      rule: "text",
      first_sample_at: "timestamptz",
      last_sample_at: "timestamptz",
      average_power_w: "numeric",
      measured_subset_average_w: "numeric",
      local_limit_kw: "numeric",
    };
    const result = await db.query(
      `INSERT INTO power_measurements(${columns.join(",")}) SELECT ${columns.join(",")} FROM jsonb_to_recordset($1::jsonb) AS x(${columns.map((c) => c + " " + (types[c] ?? "bigint")).join(",")})
      ON CONFLICT(station_id,interval_start) DO UPDATE SET ${columns
        .filter((c) => !["station_id", "interval_start"].includes(c))
        .map((c) => c + "=EXCLUDED." + c)
        .join(",")},built_at=clock_timestamp()
      WHERE (to_jsonb(power_measurements)-'built_at') IS DISTINCT FROM (to_jsonb(EXCLUDED)-'built_at')`,
      [JSON.stringify(rows)],
    );
    return result.rowCount ?? 0;
  });
}
