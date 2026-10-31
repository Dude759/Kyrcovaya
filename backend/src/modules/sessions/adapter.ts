import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Database } from "../../db/pool.js";
import { chargingWork, lockSessionGraph, localPowerProof } from "./graph.js";
import { databaseNow } from "../reservations/service.js";
import { livePowerInput, recordChargingPower, safeAdmission } from "./power.js";

export interface ChargerAdapter {
  execute(commandId: string): Promise<any | null>;
  sample(sessionId: string): Promise<void>;
  setPower(commandId: string, ttl?: number): Promise<any | null>;
}
export function integrateEnergy(
  energy: number,
  remainder: number,
  power: number,
  milliseconds: number,
  budget: number,
) {
  const work =
    BigInt(remainder) + BigInt(power) * BigInt(Math.floor(milliseconds));
  return {
    energy: Math.min(budget, energy + Number(work / 3600000n)),
    remainder: Number(work % 3600000n),
  };
}
// Time/energy exist only in this server simulator. No device readings are accepted from HTTP clients.
export class SimulatorChargerAdapter implements ChargerAdapter {
  readonly epoch: string;
  constructor(
    private pool: Database,
    epoch = randomUUID(),
  ) {
    this.epoch = epoch;
  }
  private async measurement(
    db: PoolClient,
    graph: Awaited<ReturnType<typeof lockSessionGraph>>,
    force: boolean,
    stop: boolean,
    transition?: {
      power: number;
      beforeInsert: (measurementId: string, at: Date) => Promise<void>;
    },
  ) {
    const { s } = graph;
    const state = (
      await db.query(
        "SELECT * FROM simulator_session_state WHERE session_id=$1 FOR UPDATE",
        [s.id],
      )
    ).rows[0];
    const now = await databaseNow(db),
      elapsed = state.last_tick_at
        ? now.getTime() - state.last_tick_at.getTime()
        : 0;
    if (!force && state.epoch === this.epoch && elapsed < 10000) return null;
    const gap =
      !!state.last_tick_at && (state.epoch !== this.epoch || elapsed > 15000);
    const proof = await localPowerProof(db, graph);
    const usable =
      !gap && proof && state.state === "charging"
        ? Math.max(
            0,
            Math.min(
              elapsed,
              s.window_end.getTime() -
                (state.last_tick_at?.getTime() ?? now.getTime()),
            ),
          )
        : 0;
    const confirmed = (
      await db.query(
        "SELECT acknowledged_w FROM session_power_state WHERE session_id=$1",
        [s.id],
      )
    ).rows[0];
    const work = integrateEnergy(
      Number(state.energy_wh),
      Number(state.remainder_watt_ms),
      Number(confirmed.acknowledged_w),
      usable,
      Number(s.energy_budget_wh),
    );
    const energy = work.energy;
    const ended =
      stop ||
      !proof ||
      now >= s.window_end ||
      energy >= Number(s.energy_budget_wh) ||
      state.state === "stopped";
    const power =
      ended || state.state !== "charging"
        ? 0
        : (transition?.power ?? Number(confirmed.acknowledged_w));
    const sequence = Number(state.sequence_no) + 1;
    const measurementId = randomUUID();
    if (transition) await transition.beforeInsert(measurementId, now);
    const measurement = (
      await db.query(
        `INSERT INTO session_measurements(session_id,sequence_no,sampled_at,energy_wh,power_w,gap,final,id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [s.id, sequence, now, energy, power, gap, stop, measurementId],
      )
    ).rows[0];
    await db.query(
      `UPDATE simulator_session_state SET state=CASE WHEN $2 THEN 'stopped' ELSE state END,energy_wh=$3,
    remainder_watt_ms=$4,sequence_no=$5,last_tick_at=$6,epoch=$7 WHERE session_id=$1`,
      [
        s.id,
        ended,
        energy,
        ended ? 0 : work.remainder,
        sequence,
        now,
        this.epoch,
      ],
    );
    await db.query(
      "UPDATE charging_sessions SET energy_wh=$2,last_sequence=$3,measured_at=$4,telemetry_gap=telemetry_gap OR $5 WHERE id=$1",
      [s.id, energy, sequence, now, gap],
    );
    return measurement;
  }
  async execute(commandId: string) {
    const candidate = (
      await this.pool.query(
        "SELECT session_id FROM charging_commands WHERE id=$1",
        [commandId],
      )
    ).rows[0];
    if (!candidate) return null;
    return chargingWork(this.pool, async (db) => {
      const graph = await lockSessionGraph(db, candidate.session_id),
        { s } = graph;
      const command = (
        await db.query(
          "SELECT * FROM charging_commands WHERE id=$1 FOR UPDATE",
          [commandId],
        )
      ).rows[0];
      const previous = (
        await db.query(
          "SELECT * FROM simulator_command_receipts WHERE command_id=$1",
          [commandId],
        )
      ).rows[0];
      if (previous) return previous;
      if (["completed", "failed"].includes(s.status)) return null;
      const device = (
        await db.query(
          "SELECT * FROM simulator_devices WHERE connector_id=$1",
          [s.connector_id],
        )
      ).rows[0];
      if (!device.online || command.ready_at > (await databaseNow(db)))
        return null;
      let accepted = true,
        reason = null;
      if (command.kind === "start") {
        const now = await databaseNow(db);
        accepted =
          s.status === "starting" &&
          !device.reject_start &&
          (await localPowerProof(db, graph)) &&
          (await safeAdmission(db, s.organization_id, 0)) &&
          now >= s.window_start &&
          now < s.window_end &&
          now.getTime() < s.window_start.getTime() + 15 * 60000;
        reason = accepted ? null : "start_rejected";
        await db.query(
          "UPDATE simulator_session_state SET state=$2,epoch=$3,last_tick_at=clock_timestamp() WHERE session_id=$1",
          [s.id, accepted ? "charging" : "stopped", this.epoch],
        );
        if (accepted)
          await recordChargingPower(
            db,
            s.id,
            command.id,
            Number(s.allocated_power_w),
            now,
          );
      }
      const measurement = await this.measurement(
        db,
        graph,
        true,
        command.kind === "stop" || !accepted,
      );
      if (command.kind === "stop" || !accepted)
        await recordChargingPower(
          db,
          s.id,
          command.id,
          0,
          measurement.sampled_at,
        );
      return (
        await db.query(
          `INSERT INTO simulator_command_receipts(command_id,session_id,accepted,measurement_id,reason)
    VALUES($1,$2,$3,$4,$5) RETURNING *`,
          [command.id, s.id, accepted, measurement.id, reason],
        )
      ).rows[0];
    });
  }
  async setPower(commandId: string, ttl = 60) {
    const candidate = (
      await this.pool.query(
        "SELECT session_id FROM power_commands WHERE id=$1",
        [commandId],
      )
    ).rows[0];
    if (!candidate) return null;
    return chargingWork(this.pool, async (db) => {
      const graph = await lockSessionGraph(db, candidate.session_id),
        { s } = graph;
      const c = (
        await db.query("SELECT * FROM power_commands WHERE id=$1 FOR UPDATE", [
          commandId,
        ])
      ).rows[0];
      const previous = (
        await db.query(
          "SELECT * FROM power_command_receipts WHERE command_id=$1",
          [commandId],
        )
      ).rows[0];
      if (previous) return previous;
      const st = (
        await db.query(
          "SELECT * FROM session_power_state WHERE session_id=$1 FOR UPDATE",
          [s.id],
        )
      ).rows[0];
      const device = (
        await db.query(
          "SELECT * FROM simulator_devices WHERE connector_id=$1 FOR UPDATE",
          [s.connector_id],
        )
      ).rows[0];
      const live = await livePowerInput(db, s.organization_id, ttl);
      const plan = (
        await db.query("SELECT * FROM power_dispatch_plans WHERE id=$1", [
          c.plan_id,
        ])
      ).rows[0];
      const desired = live.assignments.find((a) => a.id === s.id)?.plannedW;
      let reason: string | null =
        !st.managed || s.status !== "active"
          ? "session_not_active"
          : Number(c.revision) < Number(st.issued_revision) ||
              Number(c.revision) <= Number(st.revision)
            ? "superseded"
            : plan.fingerprint !== live.fingerprint ||
                Number(c.target_power_w) !== desired
              ? "input_changed"
              : device.reject_power
                ? "device_rejected"
                : null;
      const now = await databaseNow(db);
      if (!reason && !device.online) {
        await db.query(
          "UPDATE simulator_session_state SET epoch=null WHERE session_id=$1",
          [s.id],
        );
        await db.query(
          "UPDATE session_power_state SET reconciliation='degraded' WHERE session_id=$1",
          [s.id],
        );
        return null;
      }
      if (!reason && now < c.ready_at) return null;
      if (
        !reason &&
        (now >= s.window_end ||
          Number(s.energy_wh) >= Number(s.energy_budget_wh))
      )
        reason = "session_window_or_budget";
      const target = Number(c.target_power_w);
      if (!reason && target > 0 && !(await localPowerProof(db, graph)))
        reason = "local_limit";
      if (
        !reason &&
        target > 0 &&
        (
          await db.query(
            "SELECT state FROM simulator_session_state WHERE session_id=$1",
            [s.id],
          )
        ).rows[0].state !== "charging"
      )
        reason = "device_stopped";
      if (!reason && target > Number(st.acknowledged_w)) {
        const load = live.rows.reduce(
          (n, r) =>
            n +
            Number(
              r.status === "starting" ? r.allocated_power_w : r.acknowledged_w,
            ),
          0,
        );
        if (
          live.input.budgetW === null ||
          load - Number(st.acknowledged_w) + target > live.input.budgetW
        )
          return null;
      }
      if (reason)
        return (
          await db.query(
            `INSERT INTO power_command_receipts(command_id,session_id,accepted,power_w,effective_at,reason) VALUES($1,$2,false,$3,$4,$5) RETURNING *`,
            [c.id, s.id, st.acknowledged_w, now, reason],
          )
        ).rows[0];
      await this.measurement(db, graph, true, false, {
        power: target,
        beforeInsert: async (id, at) => {
          await db.query(
            `INSERT INTO power_command_receipts(command_id,session_id,accepted,power_w,effective_at,measurement_id) VALUES($1,$2,true,$3,$4,$5)`,
            [c.id, s.id, target, at, id],
          );
          await db.query(
            `INSERT INTO session_power_history(session_id,revision,power_w,effective_at,power_command_id) VALUES($1,$2,$3,$4,$5)`,
            [s.id, c.revision, target, at, c.id],
          );
          await db.query(
            `UPDATE session_power_state SET acknowledged_w=$2,revision=$3,effective_at=$4,reconciliation='acknowledged',reconciled_at=$4 WHERE session_id=$1`,
            [s.id, target, c.revision, at],
          );
        },
      });
      return (
        await db.query(
          "SELECT * FROM power_command_receipts WHERE command_id=$1",
          [c.id],
        )
      ).rows[0];
    });
  }
  async sample(sessionId: string) {
    await chargingWork(this.pool, async (db) => {
      const graph = await lockSessionGraph(db, sessionId);
      if (!["active", "stopping"].includes(graph.s.status)) return;
      const device = (
        await db.query(
          "SELECT online FROM simulator_devices WHERE connector_id=$1",
          [graph.s.connector_id],
        )
      ).rows[0];
      if (!device.online) {
        await db.query(
          "UPDATE simulator_session_state SET epoch=null WHERE session_id=$1",
          [graph.s.id],
        );
        return;
      }
      await this.measurement(db, graph, false, false);
    });
  }
}
