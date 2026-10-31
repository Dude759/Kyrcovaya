import { Router } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import { transaction, type Database } from "../../db/pool.js";
import { operatorOnly } from "../auth/middleware.js";
import { HttpError } from "../../middleware/errors.js";
import { hash } from "../payments/provider.js";
import { idempotencyKey } from "../payments/validation.js";
import { dispatchLock, dispatchEnabled } from "../sessions/power.js";
import {
  gridBudget,
  maxMin,
  SimulatorGridAdapter,
  scenarios,
  type Demand,
} from "./grid-engine.js";
const adapter = new SimulatorGridAdapter();
export async function gridView(db: PoolClient, org: string, ttl: number) {
  const state = (
    await db.query("SELECT * FROM grid_states WHERE organization_id=$1", [org])
  ).rows[0];
  const s = (
    await db.query(
      "SELECT * FROM grid_samples WHERE organization_id=$1 ORDER BY id DESC LIMIT 1",
      [org],
    )
  ).rows[0];
  const now = (await db.query("SELECT clock_timestamp() AS now")).rows[0].now;
  const limit =
    Number(
      (
        await db.query(
          "SELECT network_limit_kw FROM organizations WHERE id=$1",
          [org],
        )
      ).rows[0].network_limit_kw,
    ) * 1000;
  const reading = {
    availablePowerKw:
      s?.available_power_w == null ? null : Number(s.available_power_w) / 1000,
    baseLoadKw: s?.base_load_w == null ? null : Number(s.base_load_w) / 1000,
    status: s?.status ?? "online",
    receivedAt: s?.received_at?.toISOString() ?? null,
    source: "simulator" as const,
  };
  // A snapshot from another configured version cannot authorize live dispatch.
  const matchingVersion =
    !!s && !!state && String(s.state_version) === String(state.version);
  return {
    scenario: state?.scenario ?? "missing",
    workload: state?.workload ?? "live",
    version: state ? String(state.version) : null,
    sampleId: s ? String(s.id) : null,
    asOf: now.toISOString(),
    reading,
    operatorLimitW: limit,
    ...(matchingVersion
      ? gridBudget(
          reading,
          limit,
          now,
          Math.min(ttl, s?.freshness_seconds ?? ttl),
        )
      : { budgetW: null, validity: "missing" }),
    freshnessSeconds: Math.min(ttl, s?.freshness_seconds ?? ttl),
    mode: "shadow",
  };
}
async function planView(db: PoolClient, org: string, ttl: number) {
  const grid = await gridView(db, org, ttl);
  const run = (
    await db.query(
      "SELECT * FROM power_plan_runs WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
      [org],
    )
  ).rows[0];
  if (!run) return { grid, usable: false, plan: null };
  const assignments = (
    await db.query(
      "SELECT * FROM power_plan_assignments WHERE run_id=$1 AND organization_id=$2 ORDER BY subject_id",
      [run.id, org],
    )
  ).rows.map((r) => ({
    id: r.subject_id,
    stationId: r.station_key,
    requestedW: Number(r.requested_w),
    portLimitW: Number(r.port_limit_w),
    stationLimitW: Number(r.station_limit_w),
    plannedW: r.planned_w === null ? null : Number(r.planned_w),
    acknowledgedW: null,
    measuredW: r.measured_w === null ? null : Number(r.measured_w),
    currentAllocatedW:
      r.current_allocated_w === null ? null : Number(r.current_allocated_w),
  }));
  return {
    grid,
    usable:
      grid.validity === "fresh" && String(run.sample_id) === grid.sampleId,
    plan: {
      id: run.id,
      sampleId: String(run.sample_id),
      version: run.version,
      mode: run.mode,
      workload: run.workload,
      budgetW: run.budget_w === null ? null : Number(run.budget_w),
      input: run.input,
      createdAt: run.created_at.toISOString(),
      assignments,
    },
  };
}
async function build(db: PoolClient, org: string, ttl: number) {
  const state = (
    await db.query("SELECT * FROM grid_states WHERE organization_id=$1", [org])
  ).rows[0];
  if (!state) return;
  const now = (await db.query("SELECT clock_timestamp() AS now")).rows[0].now;
  const key =
    state.version +
    ":" +
    (["missing", "offline", "stale"].includes(state.scenario)
      ? state.scenario
      : Math.floor(now.getTime() / 15000));
  if (
    (
      await db.query(
        "SELECT 1 FROM grid_samples WHERE organization_id=$1 AND sample_key=$2",
        [org, key],
      )
    ).rowCount
  )
    return;
  const reading = adapter.read(state.scenario, now, ttl);
  const limit = Math.floor(
    Number(
      (
        await db.query(
          "SELECT network_limit_kw FROM organizations WHERE id=$1",
          [org],
        )
      ).rows[0].network_limit_kw,
    ) * 1000,
  );
  const budget = gridBudget(reading, limit, now, ttl);
  const sample = (
    await db.query(
      `INSERT INTO grid_samples(organization_id,sample_key,state_version,scenario,status,received_at,available_power_w,base_load_w,operator_limit_w,budget_w,validity,freshness_seconds) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        org,
        key,
        state.version,
        state.scenario,
        reading.status,
        reading.receivedAt,
        reading.availablePowerKw === null
          ? null
          : reading.availablePowerKw * 1000,
        reading.baseLoadKw === null ? null : reading.baseLoadKw * 1000,
        limit,
        budget.budgetW,
        budget.validity,
        ttl,
      ],
    )
  ).rows[0];
  const live = (
    await db.query(
      `SELECT s.id,s.station_id,s.allocated_power_w,c.max_power_kw,least(st.limit_kw,st.max_power_kw) AS station_limit,
    CASE WHEN d.online AND m.sampled_at<=clock_timestamp() AND m.sampled_at>=clock_timestamp()-interval '60 seconds' AND s.status IN ('active','stopping') THEN m.power_w END AS measured_w
    FROM charging_sessions s JOIN stations st ON st.id=s.station_id JOIN connectors c ON c.id=s.connector_id LEFT JOIN simulator_devices d ON d.connector_id=c.id
    LEFT JOIN LATERAL(SELECT power_w,sampled_at FROM session_measurements WHERE session_id=s.id ORDER BY sequence_no DESC LIMIT 1)m ON true
    WHERE s.organization_id=$1 AND s.status IN ('starting','active','stopping') ORDER BY s.id`,
      [org],
    )
  ).rows;
  const demands: Demand[] =
    state.workload === "training"
      ? [100000, 80000, 60000, 50000].map((w, i) => ({
          id: "training-" + (i + 1),
          stationId: "training-station",
          requestedW: w,
          portLimitW: w,
          stationLimitW: 500000,
        }))
      : live.map((r) => ({
          id: r.id,
          stationId: r.station_id,
          requestedW: Number(r.allocated_power_w),
          portLimitW: Math.floor(Number(r.max_power_kw) * 1000),
          stationLimitW: Math.floor(Number(r.station_limit) * 1000),
        }));
  const result =
    budget.budgetW === null
      ? demands.map((d) => ({ ...d, plannedW: null }))
      : maxMin(demands, budget.budgetW);
  const run = (
    await db.query(
      "INSERT INTO power_plan_runs(organization_id,sample_id,workload,budget_w,input) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [
        org,
        sample.id,
        state.workload,
        budget.budgetW,
        JSON.stringify({
          demands,
          reading,
          operatorLimitW: limit,
          validity: budget.validity,
          requestedSource:
            state.workload === "live"
              ? "initial_session_allocation_snapshot"
              : "explicit_training_workload",
        }),
      ],
    )
  ).rows[0];
  for (const d of result) {
    const actual =
      state.workload === "live" ? live.find((r) => r.id === d.id) : null;
    await db.query(
      `INSERT INTO power_plan_assignments(run_id,organization_id,subject_id,station_key,requested_w,port_limit_w,station_limit_w,planned_w,measured_w,current_allocated_w) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        run.id,
        org,
        d.id,
        d.stationId,
        d.requestedW,
        d.portLimitW,
        d.stationLimitW,
        d.plannedW,
        actual?.measured_w ?? null,
        actual?.allocated_power_w ?? null,
      ],
    );
  }
}
export async function runGridCycle(pool: Database, ttl = 60) {
  const orgs = (
    await pool.query(
      "SELECT organization_id FROM grid_states ORDER BY organization_id",
    )
  ).rows;
  for (const { organization_id: org } of orgs)
    await transaction(pool, async (db) => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      if (
        (
          await db.query(
            "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok",
            ["grid:" + org],
          )
        ).rows[0].ok
      )
        await build(db, org, ttl);
    });
}
export function gridRoutes(pool: Database, ttl = 60) {
  const router = Router();
  router.use(operatorOnly);
  const read = (op: (db: PoolClient) => Promise<any>) =>
    transaction(pool, async (db) => {
      await db.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      return op(db);
    });
  router.get("/grid", async (req, res) => {
    z.object({}).strict().parse(req.query);
    res.json(
      await read((db) => gridView(db, req.identity!.organizationId!, ttl)),
    );
  });
  router.get("/power/plan", async (req, res) => {
    z.object({}).strict().parse(req.query);
    res.json(
      await read((db) => planView(db, req.identity!.organizationId!, ttl)),
    );
  });
  router.get("/grid/history", async (req, res) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z
          .string()
          .regex(/^[1-9][0-9]{0,18}$/)
          .optional(),
      })
      .strict()
      .parse(req.query);
    const rows = (
      await pool.query(
        `SELECT id::text,scenario,status,source,received_at,available_power_w,base_load_w,operator_limit_w,budget_w,validity,state_version::text,freshness_seconds,created_at FROM grid_samples WHERE organization_id=$1 AND ($2::bigint IS NULL OR id<$2::bigint) ORDER BY grid_samples.id DESC LIMIT $3`,
        [req.identity!.organizationId, q.cursor ?? null, q.limit + 1],
      )
    ).rows;
    res.json({
      items: rows.slice(0, q.limit),
      nextCursor: rows.length > q.limit ? rows[q.limit - 1].id : null,
    });
  });
  router.post("/grid/scenario", async (req, res) => {
    const input = z
      .object({
        scenario: z.enum(scenarios),
        workload: z.enum(["live", "training"]).default("live"),
      })
      .strict()
      .parse(req.body);
    const key = idempotencyKey.parse(req.headers["idempotency-key"]),
      signature = hash(JSON.stringify(input)),
      org = req.identity!.organizationId!;
    res.json(
      await transaction(pool, async (db) => {
        await dispatchLock(db, org);
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "grid:" + org,
        ]);
        const old = (
          await db.query(
            "SELECT * FROM grid_requests WHERE organization_id=$1 AND idempotency_key=$2",
            [org, key],
          )
        ).rows[0];
        if (old) {
          if (old.request_hash !== signature)
            throw new HttpError(
              409,
              "Ключ уже использован с другим сценарием.",
            );
          return old.result;
        }
        const before =
          (
            await db.query(
              "SELECT * FROM grid_states WHERE organization_id=$1",
              [org],
            )
          ).rows[0] ?? null;
        if (input.workload === "training" && (await dispatchEnabled(db, org)))
          throw new HttpError(
            409,
            "Training недоступен при включённом применении мощности.",
          );
        await db.query(
          `INSERT INTO grid_states(organization_id,scenario,workload,version) VALUES($1,$2,$3,1) ON CONFLICT(organization_id) DO UPDATE SET scenario=EXCLUDED.scenario,workload=EXCLUDED.workload,version=grid_states.version+1,updated_at=clock_timestamp()`,
          [org, input.scenario, input.workload],
        );
        await build(db, org, ttl);
        const result = await planView(db, org, ttl);
        await db.query(
          "INSERT INTO grid_actions(organization_id,actor_id,before_data,after_data) VALUES($1,$2,$3,$4)",
          [org, req.identity!.id, before, JSON.stringify(result)],
        );
        await db.query("INSERT INTO grid_requests VALUES($1,$2,$3,$4)", [
          org,
          key,
          signature,
          JSON.stringify(result),
        ]);
        return result;
      }),
    );
  });
  return router;
}
