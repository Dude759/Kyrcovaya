import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Database } from "../../db/pool.js";
import { chargingWork, lockSessionGraph, localPowerProof } from "./graph.js";
import { databaseNow } from "../reservations/service.js";

export interface ChargerAdapter {
  execute(commandId: string): Promise<any | null>;
  sample(sessionId: string): Promise<void>;
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
    const work =
      Number(state.remainder_watt_ms) + Number(s.allocated_power_w) * usable;
    const energy = Math.min(
      Number(s.energy_budget_wh),
      Number(state.energy_wh) + Math.floor(work / 3600000),
    );
    const ended =
      stop ||
      !proof ||
      now >= s.window_end ||
      energy >= Number(s.energy_budget_wh) ||
      state.state === "stopped";
    const power =
      ended || state.state !== "charging" ? 0 : Number(s.allocated_power_w);
    const sequence = Number(state.sequence_no) + 1;
    const measurement = (
      await db.query(
        `INSERT INTO session_measurements(session_id,sequence_no,sampled_at,energy_wh,power_w,gap,final)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [s.id, sequence, now, energy, power, gap, stop],
      )
    ).rows[0];
    await db.query(
      `UPDATE simulator_session_state SET state=CASE WHEN $2 THEN 'stopped' ELSE state END,energy_wh=$3,
    remainder_watt_ms=$4,sequence_no=$5,last_tick_at=$6,epoch=$7 WHERE session_id=$1`,
      [
        s.id,
        ended,
        energy,
        ended ? 0 : work % 3600000,
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
          now >= s.window_start &&
          now < s.window_end &&
          now.getTime() < s.window_start.getTime() + 15 * 60000;
        reason = accepted ? null : "start_rejected";
        await db.query(
          "UPDATE simulator_session_state SET state=$2,epoch=$3,last_tick_at=clock_timestamp() WHERE session_id=$1",
          [s.id, accepted ? "charging" : "stopped", this.epoch],
        );
      }
      const measurement = await this.measurement(
        db,
        graph,
        true,
        command.kind === "stop" || !accepted,
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
      if (!device.online) return;
      await this.measurement(db, graph, false, false);
    });
  }
}
