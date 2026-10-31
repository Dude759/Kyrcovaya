import type { PoolClient } from "pg";
import { Router } from "express";
import { z } from "zod";
import type { Database } from "../../db/pool.js";
import { transaction } from "../../db/pool.js";
import { HttpError } from "../../middleware/errors.js";
import { operatorOnly } from "../auth/middleware.js";
import { hash } from "../payments/provider.js";
import { idempotencyKey } from "../payments/validation.js";
import { gridView } from "../operator/grid.js";
import { maxMin } from "../operator/grid-engine.js";
import { chargingWork, lockSessionGraph } from "./graph.js";
import type { ChargerAdapter } from "./adapter.js";

export async function dispatchLock(db: PoolClient, org: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "dispatch:" + org,
  ]);
}
export async function dispatchEnabled(db: PoolClient, org: string) {
  return !!(
    await db.query(
      "SELECT enabled FROM power_dispatch_settings WHERE organization_id=$1",
      [org],
    )
  ).rows[0]?.enabled;
}
export async function livePowerInput(db: PoolClient, org: string, ttl = 60) {
  const grid = await gridView(db, org, ttl);
  const rows = (
    await db.query(
      `SELECT s.id,s.station_id,s.connector_id,s.status,s.allocated_power_w,
    c.max_power_kw,c.operating_state AS port_status,c.archived_at AS port_archived,
    least(st.limit_kw,st.max_power_kw) AS station_limit,st.operating_state AS station_status,st.archived_at AS station_archived,
    d.online,d.reject_power,ps.managed,ps.acknowledged_w,ps.requested_w
    FROM charging_sessions s JOIN stations st ON st.id=s.station_id JOIN connectors c ON c.id=s.connector_id
    JOIN session_power_state ps ON ps.session_id=s.id LEFT JOIN simulator_devices d ON d.connector_id=c.id
    WHERE s.organization_id=$1 AND s.status IN ('starting','active','stopping') ORDER BY s.id`,
      [org],
    )
  ).rows;
  // Only material inputs enter the fingerprint: fresh equivalent heartbeat samples do not invalidate a delayed command.
  const input = {
    gridVersion: grid.version,
    budgetW: grid.workload === "live" ? grid.budgetW : null,
    validity: grid.workload === "live" ? grid.validity : "training",
    operatorLimitW: grid.operatorLimitW,
    sessions: rows.map((r) => ({
      id: r.id,
      stationId: r.station_id,
      status: r.status,
      requestedW: Number(r.requested_w),
      portLimitW: Math.floor(Number(r.max_power_kw) * 1000),
      stationLimitW: Math.floor(Number(r.station_limit) * 1000),
      online: !!r.online,
      rejectPower: !!r.reject_power,
      available:
        !r.port_archived &&
        !r.station_archived &&
        r.port_status === "idle" &&
        r.station_status === "online",
      managed: r.managed,
    })),
  };
  const demands = input.sessions.map((s) => ({
    id: s.id,
    stationId: s.stationId,
    requestedW:
      s.status === "active" && s.online && s.available && s.managed
        ? s.requestedW
        : 0,
    portLimitW: s.portLimitW,
    stationLimitW: s.stationLimitW,
  }));
  const assignments = maxMin(demands, input.budgetW ?? 0);
  return {
    input,
    fingerprint: hash(JSON.stringify(input)),
    assignments,
    rows,
    grid,
  };
}
export async function safeAdmission(
  db: PoolClient,
  org: string,
  extraW: number,
  ttl = 60,
) {
  if (!(await dispatchEnabled(db, org))) return true;
  const live = await livePowerInput(db, org, ttl);
  const pending = (
    await db.query(
      `SELECT 1 FROM power_commands WHERE organization_id=$1 AND status IN ('pending','submitted') LIMIT 1`,
      [org],
    )
  ).rowCount;
  const load = live.rows.reduce(
    (n, r) =>
      n +
      Number(r.status === "starting" ? r.allocated_power_w : r.acknowledged_w),
    0,
  );
  return (
    live.input.budgetW !== null &&
    !pending &&
    live.rows.every((r) => r.online && r.managed) &&
    load + extraW <= live.input.budgetW
  );
}
export async function recordChargingPower(
  db: PoolClient,
  session: string,
  command: string,
  power: number,
  at: Date,
) {
  const st = (
    await db.query(
      "SELECT * FROM session_power_state WHERE session_id=$1 FOR UPDATE",
      [session],
    )
  ).rows[0];
  const revision = Number(st.issued_revision) + 1;
  await db.query(
    `INSERT INTO session_power_history(session_id,revision,power_w,effective_at,charging_command_id) VALUES($1,$2,$3,$4,$5)`,
    [session, revision, power, at, command],
  );
  await db.query(
    `UPDATE session_power_state SET acknowledged_w=$2,revision=$3,issued_revision=$3,effective_at=$4,reconciliation='acknowledged',reconciled_at=$4 WHERE session_id=$1`,
    [session, power, revision, at],
  );
}
export async function planDispatch(pool: Database, org: string, ttl = 60) {
  return chargingWork(pool, async (db) => {
    await dispatchLock(db, org);
    if (!(await dispatchEnabled(db, org))) return;
    const live = await livePowerInput(db, org, ttl);
    let plan = (
      await db.query(
        "SELECT * FROM power_dispatch_plans WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
        [org],
      )
    ).rows[0];
    if (plan?.fingerprint !== live.fingerprint)
      plan = (
        await db.query(
          `INSERT INTO power_dispatch_plans(organization_id,sample_id,fingerprint,input,assignments,budget_w) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
          [
            org,
            live.grid.sampleId,
            live.fingerprint,
            JSON.stringify(live.input),
            JSON.stringify(live.assignments),
            live.input.budgetW,
          ],
        )
      ).rows[0];
    for (const a of live.assignments) {
      const row = live.rows.find((r) => r.id === a.id)!;
      if (!row.managed || row.status !== "active") continue;
      const latest = (
        await db.query(
          "SELECT * FROM power_commands WHERE session_id=$1 ORDER BY revision DESC LIMIT 1",
          [a.id],
        )
      ).rows[0];
      if (
        Number(row.acknowledged_w) === a.plannedW &&
        (!latest || !["pending", "submitted"].includes(latest.status))
      )
        continue;
      if (
        latest?.plan_id === plan.id &&
        Number(latest.target_power_w) === a.plannedW
      )
        continue;
      const st = (
        await db.query(
          "UPDATE session_power_state SET issued_revision=issued_revision+1,reconciliation='pending' WHERE session_id=$1 RETURNING issued_revision",
          [a.id],
        )
      ).rows[0];
      await db.query(
        `INSERT INTO power_commands(session_id,organization_id,plan_id,revision,target_power_w,ready_at)
        SELECT $1,$2,$3,$4,$5,clock_timestamp()+(command_delay_ms*interval '1 millisecond') FROM simulator_devices WHERE connector_id=$6`,
        [a.id, org, plan.id, st.issued_revision, a.plannedW, row.connector_id],
      );
    }
    return plan;
  });
}
export async function acknowledgePowerReceipt(
  pool: Database,
  commandId: string,
) {
  const candidate = (
    await pool.query("SELECT session_id FROM power_commands WHERE id=$1", [
      commandId,
    ])
  ).rows[0];
  if (!candidate) return;
  await chargingWork(pool, async (db) => {
    await lockSessionGraph(db, candidate.session_id);
    const c = (
      await db.query("SELECT * FROM power_commands WHERE id=$1 FOR UPDATE", [
        commandId,
      ])
    ).rows[0];
    const r = (
      await db.query(
        "SELECT * FROM power_command_receipts WHERE command_id=$1",
        [commandId],
      )
    ).rows[0];
    if (!r || ["acknowledged", "rejected"].includes(c.status)) return;
    await db.query(
      "UPDATE power_commands SET status=$2,confirmed_at=$3 WHERE id=$1",
      [c.id, r.accepted ? "acknowledged" : "rejected", r.effective_at],
    );
    // Receipt recovery never rewrites the physical state; the adapter already committed it atomically.
    await db.query(
      `UPDATE session_power_state SET reconciliation=$2,reconciled_at=clock_timestamp() WHERE session_id=$1 AND issued_revision=$3`,
      [c.session_id, r.accepted ? "acknowledged" : "rejected", c.revision],
    );
  });
}
export async function runPowerDispatch(
  pool: Database,
  adapter: ChargerAdapter,
  ttl = 60,
) {
  // Recover receipts before calculating or delivering new work.
  const recover = (
    await pool.query(
      `SELECT c.id FROM power_commands c JOIN power_command_receipts r ON r.command_id=c.id WHERE c.status IN ('pending','submitted') ORDER BY c.created_at`,
    )
  ).rows;
  for (const c of recover) await acknowledgePowerReceipt(pool, c.id);
  const orgs = (
    await pool.query(
      "SELECT organization_id FROM power_dispatch_settings WHERE enabled ORDER BY organization_id",
    )
  ).rows;
  for (const r of orgs) await planDispatch(pool, r.organization_id, ttl);
  const commands = (
    await pool.query(`SELECT c.id,c.session_id FROM power_commands c JOIN session_power_state st ON st.session_id=c.session_id
    WHERE c.status IN ('pending','submitted') ORDER BY (c.target_power_w>st.acknowledged_w),c.created_at,c.revision LIMIT 100`)
  ).rows;
  for (const c of commands) {
    await chargingWork(pool, async (db) => {
      await lockSessionGraph(db, c.session_id);
      await db.query(
        "UPDATE power_commands SET status='submitted',deliveries=deliveries+1 WHERE id=$1 AND status IN ('pending','submitted')",
        [c.id],
      );
    });
    const receipt = await adapter.setPower(c.id, ttl);
    if (receipt) await acknowledgePowerReceipt(pool, c.id);
  }
}
export async function dispatchView(db: PoolClient, org: string, ttl = 60) {
  const live = await livePowerInput(db, org, ttl);
  const enabled = await dispatchEnabled(db, org);
  const rows = (
    await db.query(
      `SELECT s.id,s.station_id,s.status,ps.requested_w,ps.acknowledged_w,ps.effective_at,ps.managed,ps.reconciliation,
    c.id AS command_id,c.target_power_w,c.status AS command_status,c.confirmed_at,r.reason,
    CASE WHEN d.online AND m.sampled_at>=clock_timestamp()-interval '60 seconds' THEN m.power_w END AS measured_w
    FROM charging_sessions s JOIN session_power_state ps ON ps.session_id=s.id LEFT JOIN simulator_devices d ON d.connector_id=s.connector_id
    LEFT JOIN LATERAL(SELECT * FROM power_commands WHERE session_id=s.id ORDER BY revision DESC LIMIT 1)c ON true
    LEFT JOIN power_command_receipts r ON r.command_id=c.id
    LEFT JOIN LATERAL(SELECT * FROM session_measurements WHERE session_id=s.id ORDER BY sequence_no DESC LIMIT 1)m ON true
    WHERE s.organization_id=$1 AND s.status IN ('starting','active','stopping') ORDER BY s.id`,
      [org],
    )
  ).rows;
  const acknowledgedW = rows.reduce((n, r) => n + Number(r.acknowledged_w), 0);
  const safe =
    live.input.budgetW !== null &&
    acknowledgedW <= live.input.budgetW &&
    rows.every((r) => r.measured_w !== null);
  const history = (
    await db.query(
      `SELECT p.id,p.created_at,p.budget_w,p.input->>'gridVersion' AS grid_version,
    (SELECT sum(h.power_w) FROM charging_sessions s JOIN LATERAL(SELECT power_w FROM session_power_history WHERE session_id=s.id AND effective_at<=p.created_at ORDER BY effective_at DESC,id DESC LIMIT 1)h ON true
      WHERE s.organization_id=p.organization_id AND s.started_at<=p.created_at AND (s.ended_at IS NULL OR s.ended_at>p.created_at)) AS acknowledged_w,
    (SELECT COALESCE(sum((a->>'plannedW')::bigint),0) FROM jsonb_array_elements(p.assignments)a) AS planned_w
    FROM power_dispatch_plans p WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 12`,
      [org],
    )
  ).rows;
  return {
    enabled,
    source: "simulator",
    grid: live.grid,
    acknowledgedW,
    withinBudget: enabled ? safe : null,
    status: !enabled
      ? "off"
      : !safe
        ? "degraded"
        : rows.some((r) => ["pending", "submitted"].includes(r.command_status))
          ? "pending"
          : rows.some((r) => r.command_status === "rejected")
            ? "rejected"
            : "acknowledged",
    sessions: rows.map((r) => ({
      id: r.id,
      stationId: r.station_id,
      status: r.status,
      managed: r.managed,
      requestedW: Number(r.requested_w),
      plannedW: live.assignments.find((a) => a.id === r.id)?.plannedW ?? null,
      acknowledgedW: Number(r.acknowledged_w),
      measuredW: r.measured_w === null ? null : Number(r.measured_w),
      effectiveAt: r.effective_at?.toISOString() ?? null,
      reconciliation: r.reconciliation,
      command: r.command_id
        ? {
            id: r.command_id,
            targetW: Number(r.target_power_w),
            status: r.command_status,
            confirmedAt: r.confirmed_at?.toISOString() ?? null,
            reason: r.reason,
          }
        : null,
    })),
    history,
  };
}
export function dispatchRoutes(pool: Database, ttl = 60) {
  const router = Router();
  router.use(operatorOnly);
  router.get("/power/dispatch", async (req, res) => {
    z.object({}).strict().parse(req.query);
    res.json(
      await transaction(pool, async (db) => {
        await db.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        return dispatchView(db, req.identity!.organizationId!, ttl);
      }),
    );
  });
  router.post("/power/dispatch", async (req, res) => {
    const { enabled } = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(req.body);
    const key = idempotencyKey.parse(req.headers["idempotency-key"]),
      org = req.identity!.organizationId!;
    res.json(
      await chargingWork(pool, async (db) => {
        await dispatchLock(db, org);
        const old = (
          await db.query(
            "SELECT * FROM power_dispatch_actions WHERE organization_id=$1 AND idempotency_key=$2",
            [org, key],
          )
        ).rows[0];
        if (old) {
          if (old.enabled !== enabled)
            throw new HttpError(
              409,
              "Ключ уже использован для другого режима.",
            );
          return dispatchView(db, org, ttl);
        }
        if (
          (
            await db.query(
              `SELECT 1 FROM charging_sessions WHERE organization_id=$1 AND status IN ('starting','active','stopping') UNION ALL SELECT 1 FROM power_commands WHERE organization_id=$1 AND status IN ('pending','submitted') LIMIT 1`,
              [org],
            )
          ).rowCount
        )
          throw new HttpError(
            409,
            "Сначала завершите зарядки и сверку команд организации. Активные сессии не переключаются.",
          );
        const grid = await gridView(db, org, ttl);
        if (
          enabled &&
          (grid.workload !== "live" ||
            grid.budgetW === null ||
            grid.budgetW <= 0)
        )
          throw new HttpError(
            409,
            "Нужен свежий положительный Grid в режиме live.",
          );
        await db.query(
          `INSERT INTO power_dispatch_settings(organization_id,enabled,changed_by) VALUES($1,$2,$3) ON CONFLICT(organization_id) DO UPDATE SET enabled=EXCLUDED.enabled,changed_by=EXCLUDED.changed_by,changed_at=clock_timestamp()`,
          [org, enabled, req.identity!.id],
        );
        await db.query(
          "INSERT INTO power_dispatch_actions(organization_id,actor_id,enabled,idempotency_key) VALUES($1,$2,$3,$4)",
          [org, req.identity!.id, enabled, key],
        );
        return dispatchView(db, org, ttl);
      }),
    );
  });
  return router;
}
