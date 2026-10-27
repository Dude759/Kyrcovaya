import type { PoolClient } from "pg";
import type { Database } from "../../db/pool.js";
import { HttpError } from "../../middleware/errors.js";
import { databaseNow } from "../reservations/service.js";
import { hash } from "../payments/provider.js";
import { idempotencyKey } from "../payments/validation.js";
import {
  chargingWork,
  lockBookingGraph,
  lockSessionGraph,
  localPowerProof,
} from "./graph.js";
import {
  settleSession,
  recoverSessionRefund,
  confirmTestSessionRefund,
} from "./settlement.js";
import type { ChargerAdapter } from "./adapter.js";

export async function sessionDto(db: PoolClient, s: any) {
  const measurement = (
    await db.query(
      "SELECT * FROM session_measurements WHERE session_id=$1 ORDER BY sequence_no DESC LIMIT 1",
      [s.id],
    )
  ).rows[0];
  const settlement = (
    await db.query("SELECT * FROM session_settlements WHERE session_id=$1", [
      s.id,
    ])
  ).rows[0];
  const refund = (
    await db.query("SELECT * FROM session_refunds WHERE session_id=$1", [s.id])
  ).rows[0];
  const device = (
    await db.query(
      "SELECT online FROM simulator_devices WHERE connector_id=$1",
      [s.connector_id],
    )
  ).rows[0];
  const now = await databaseNow(db),
    fresh =
      !!measurement &&
      now.getTime() - measurement.sampled_at.getTime() <= 60000;
  const cost = Math.floor(
    (Number(s.energy_wh) * Number(s.tariff_kopecks) + 999) / 1000,
  );
  return {
    id: s.id,
    userId: s.user_id,
    bookingId: s.booking_id,
    paymentId: s.payment_id,
    stationId: s.station_id,
    connectorId: s.connector_id,
    connector: s.connector_type,
    status: s.status,
    requestedAt: s.requested_at.toISOString(),
    startedAt: (s.started_at ?? s.requested_at).toISOString(),
    startConfirmedAt: s.started_at?.toISOString() ?? null,
    endedAt: s.ended_at?.toISOString() ?? null,
    meteredAt: (s.measured_at ?? s.requested_at).toISOString(),
    batteryCapacity: Number(s.battery_capacity_kwh),
    energy: Number(s.energy_wh) / 1000,
    energyWh: Number(s.energy_wh),
    power:
      fresh && device?.online && s.status === "active"
        ? Number(measurement.power_w) / 1000
        : 0,
    currentPowerKw:
      fresh && device?.online && s.status === "active"
        ? Number(measurement.power_w) / 1000
        : null,
    tariff: Number(s.tariff_kopecks) / 100,
    tariffKopecks: s.tariff_kopecks,
    prepaidKopecks: Number(s.prepaid_kopecks),
    energyBudgetWh: Number(s.energy_budget_wh),
    costKopecks: cost,
    initialCharge: null,
    targetCharge: null,
    soc: null,
    socSource: "unknown",
    source: "simulator",
    stopReason: s.stop_reason,
    telemetryGap: s.telemetry_gap,
    telemetry: measurement
      ? {
          source: "simulator",
          receivedAt: measurement.sampled_at.toISOString(),
          connection: !device?.online ? "offline" : fresh ? "online" : "stale",
          energy: Number(measurement.energy_wh) / 1000,
          sequenceNo: Number(measurement.sequence_no),
          gap: measurement.gap,
        }
      : undefined,
    settlement: settlement
      ? {
          id: settlement.id,
          energyWh: Number(settlement.energy_wh),
          tariffKopecks: settlement.tariff_kopecks,
          prepaidKopecks: Number(settlement.prepaid_kopecks),
          finalCostKopecks: Number(settlement.final_cost_kopecks),
          unusedKopecks: Number(settlement.unused_kopecks),
          reason: settlement.reason,
          source: "simulator",
          createdAt: settlement.created_at.toISOString(),
        }
      : null,
    refund: refund
      ? {
          id: refund.id,
          amountKopecks: Number(refund.amount_kopecks),
          status: refund.status,
          confirmedAt: refund.confirmed_at?.toISOString() ?? null,
          test: true,
        }
      : null,
  };
}
async function command(db: PoolClient, s: any, kind: "start" | "stop") {
  const device = (
    await db.query(
      "SELECT command_delay_ms FROM simulator_devices WHERE connector_id=$1",
      [s.connector_id],
    )
  ).rows[0];
  return (
    await db.query(
      `INSERT INTO charging_commands(session_id,kind,ready_at) VALUES($1,$2,clock_timestamp()+($3::int*interval '1 millisecond'))
   ON CONFLICT(session_id,kind) DO UPDATE SET session_id=EXCLUDED.session_id RETURNING *`,
      [s.id, kind, device.command_delay_ms],
    )
  ).rows[0];
}
async function saveRequest(
  db: PoolClient,
  userId: string,
  key: string,
  signature: string,
  c: any,
) {
  await db.query(
    "INSERT INTO charging_command_requests(user_id,idempotency_key,request_hash,command_id,session_id,kind) VALUES($1,$2,$3,$4,$5,$6)",
    [userId, key, signature, c.id, c.session_id, c.kind],
  );
}
async function replay(
  db: PoolClient,
  userId: string,
  key: string,
  signature: string,
) {
  const previous = (
    await db.query(
      "SELECT * FROM charging_command_requests WHERE user_id=$1 AND idempotency_key=$2",
      [userId, key],
    )
  ).rows[0];
  if (!previous) return null;
  if (previous.request_hash !== signature)
    throw new HttpError(409, "Ключ уже использован для другой команды.");
  return (
    await db.query("SELECT * FROM charging_sessions WHERE id=$1", [
      previous.session_id,
    ])
  ).rows[0];
}
export async function startSession(
  pool: Database,
  userId: string,
  bookingId: string,
  key: unknown,
) {
  const requestKey = idempotencyKey.parse(key),
    signature = hash(JSON.stringify({ kind: "start", bookingId }));
  return chargingWork(pool, async (db) => {
    const graph = await lockBookingGraph(db, bookingId, userId),
      { b, p, station, port, reservation } = graph;
    const previous = await replay(db, userId, requestKey, signature);
    if (previous) return sessionDto(db, previous);
    const existing = (
      await db.query(
        "SELECT * FROM charging_sessions WHERE booking_id=$1 FOR UPDATE",
        [bookingId],
      )
    ).rows[0];
    if (existing) {
      const c = (
        await db.query(
          "SELECT * FROM charging_commands WHERE session_id=$1 AND kind='start'",
          [existing.id],
        )
      ).rows[0];
      await saveRequest(db, userId, requestKey, signature, c);
      return sessionDto(db, existing);
    }
    const now = await databaseNow(db);
    if (
      b.status !== "confirmed" ||
      p.status !== "succeeded" ||
      p.booking_id !== b.id ||
      reservation.state !== "confirmed" ||
      reservation.booking_id !== b.id
    )
      throw new HttpError(409, "Нужна подтверждённая оплаченная бронь.");
    if (
      now < b.start_at ||
      now >= b.end_at ||
      now.getTime() >= b.start_at.getTime() + 15 * 60000
    )
      throw new HttpError(
        409,
        "Запуск доступен с начала брони в течение 15 минут, строго до конца интервала.",
      );
    if (
      station.archived_at ||
      port.archived_at ||
      station.operating_state !== "online" ||
      port.operating_state !== "idle"
    )
      throw new HttpError(409, "Станция или физический порт недоступны.");
    if (
      (
        await db.query(
          "SELECT 1 FROM charging_sessions WHERE (user_id=$1 OR connector_id=$2) AND status IN ('starting','active','stopping')",
          [userId, port.id],
        )
      ).rows.length
    )
      throw new HttpError(
        409,
        "У водителя или порта уже есть незавершённая зарядка.",
      );
    const reserved = Number(
      (
        await db.query(
          "SELECT COALESCE(sum(allocated_power_w),0) n FROM charging_sessions WHERE station_id=$1 AND status IN ('starting','active','stopping')",
          [station.id],
        )
      ).rows[0].n,
    );
    const power = Math.floor(
      Math.min(
        22000,
        Number(port.max_power_kw) * 1000,
        Math.min(Number(station.max_power_kw), Number(station.limit_kw)) *
          1000 -
          reserved,
      ),
    );
    if (power <= 0)
      throw new HttpError(
        409,
        "Невозможно подтвердить свободную мощность в локальном лимите станции.",
      );
    const profile = (
      await db.query(
        "SELECT battery_capacity_kwh FROM driver_profiles WHERE user_id=$1 FOR SHARE",
        [userId],
      )
    ).rows[0];
    const budget =
      p.quoted_tariff_kopecks > 0
        ? Math.floor(
            (Number(p.amount_kopecks) * 1000) / p.quoted_tariff_kopecks,
          )
        : Math.floor(Number(p.quoted_energy_kwh) * 1000);
    if (budget <= 0)
      throw new HttpError(
        409,
        "Оплаченного энергетического бюджета недостаточно для запуска.",
      );
    await db.query(
      "INSERT INTO simulator_devices(connector_id) VALUES($1) ON CONFLICT DO NOTHING",
      [port.id],
    );
    const s = (
      await db.query(
        `INSERT INTO charging_sessions(booking_id,payment_id,funding_attempt_id,user_id,organization_id,station_id,connector_id,connector_type,window_start,window_end,prepaid_kopecks,tariff_kopecks,energy_budget_wh,allocated_power_w,battery_capacity_kwh)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [
          b.id,
          p.id,
          b.payment_attempt_id,
          userId,
          b.organization_id,
          b.station_id,
          port.id,
          b.connector_type,
          b.start_at,
          b.end_at,
          p.amount_kopecks,
          p.quoted_tariff_kopecks,
          budget,
          power,
          profile.battery_capacity_kwh,
        ],
      )
    ).rows[0];
    await db.query(
      "INSERT INTO simulator_session_state(session_id) VALUES($1)",
      [s.id],
    );
    const c = await command(db, s, "start");
    await saveRequest(db, userId, requestKey, signature, c);
    return sessionDto(db, s);
  });
}
async function enqueueStop(db: PoolClient, s: any, reason: string) {
  if (["completed", "failed"].includes(s.status))
    return (
      (
        await db.query(
          "SELECT * FROM charging_commands WHERE session_id=$1 AND kind='stop'",
          [s.id],
        )
      ).rows[0] ??
      (
        await db.query(
          "SELECT * FROM charging_commands WHERE session_id=$1 AND kind='start'",
          [s.id],
        )
      ).rows[0]
    );
  if (s.status !== "stopping")
    await db.query(
      "UPDATE charging_sessions SET status='stopping',stop_reason=$2 WHERE id=$1",
      [s.id, reason],
    );
  return command(db, s, "stop");
}
export async function stopSession(
  pool: Database,
  userId: string,
  id: string,
  key: unknown,
) {
  const requestKey = idempotencyKey.parse(key),
    signature = hash(JSON.stringify({ kind: "stop", sessionId: id }));
  return chargingWork(pool, async (db) => {
    const owner = (
      await db.query("SELECT user_id FROM charging_sessions WHERE id=$1", [id])
    ).rows[0];
    if (owner?.user_id !== userId)
      throw new HttpError(404, "Сессия не найдена.");
    const { s } = await lockSessionGraph(db, id);
    const previous = await replay(db, userId, requestKey, signature);
    if (previous) return sessionDto(db, previous);
    const c = await enqueueStop(db, s, "user");
    await saveRequest(db, userId, requestKey, signature, c);
    return sessionDto(
      db,
      (await db.query("SELECT * FROM charging_sessions WHERE id=$1", [id]))
        .rows[0],
    );
  });
}
export async function getSession(
  pool: Database,
  id: string,
  identity: { id: string; role: string; organizationId?: string | null },
) {
  return chargingWork(pool, async (db) => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const s = (
      await db.query(
        `SELECT * FROM charging_sessions WHERE id=$1 AND (($2='driver' AND user_id=$3) OR ($2='operator' AND organization_id=$4))`,
        [id, identity.role, identity.id, identity.organizationId ?? null],
      )
    ).rows[0];
    if (!s) throw new HttpError(404, "Сессия не найдена.");
    return sessionDto(db, s);
  });
}
async function applyReceipt(pool: Database, commandId: string) {
  const candidate = (
    await pool.query("SELECT session_id FROM charging_commands WHERE id=$1", [
      commandId,
    ])
  ).rows[0];
  await chargingWork(pool, async (db) => {
    const { s } = await lockSessionGraph(db, candidate.session_id);
    const c = (
      await db.query("SELECT * FROM charging_commands WHERE id=$1 FOR UPDATE", [
        commandId,
      ])
    ).rows[0];
    const receipt = (
      await db.query(
        "SELECT * FROM simulator_command_receipts WHERE command_id=$1 AND session_id=$2",
        [commandId, s.id],
      )
    ).rows[0];
    if (!receipt || ["acknowledged", "rejected"].includes(c.status)) return;
    await db.query(
      "UPDATE charging_commands SET status=$2,confirmed_at=(SELECT confirmed_at FROM simulator_command_receipts WHERE command_id=$1) WHERE id=$1",
      [c.id, receipt.accepted ? "acknowledged" : "rejected"],
    );
    if (["completed", "failed"].includes(s.status)) return;
    if (c.kind === "start") {
      if (receipt.accepted) {
        if (s.status === "starting")
          await db.query(
            "UPDATE charging_sessions SET status='active',started_at=(SELECT confirmed_at FROM simulator_command_receipts WHERE command_id=$2) WHERE id=$1",
            [s.id, c.id],
          );
        else if (s.status === "stopping" && !s.started_at)
          await db.query(
            "UPDATE charging_sessions SET started_at=(SELECT confirmed_at FROM simulator_command_receipts WHERE command_id=$2) WHERE id=$1",
            [s.id, c.id],
          );
        await db.query(
          "UPDATE bookings SET status='used' WHERE id=$1 AND status='confirmed'",
          [s.booking_id],
        );
      } else if (s.status === "starting")
        await settleSession(db, s, c, receipt, "failed", "start_rejected");
    } else if (receipt.accepted)
      await settleSession(
        db,
        s,
        c,
        receipt,
        "completed",
        s.stop_reason ?? "user",
      );
  });
}
export async function runChargingCycle(
  pool: Database,
  adapter: ChargerAdapter,
  refundAdapter = confirmTestSessionRefund,
) {
  const commands = (
    await pool.query(
      "SELECT id,session_id FROM charging_commands WHERE status IN ('pending','submitted') ORDER BY created_at,kind LIMIT 100",
    )
  ).rows;
  for (const c of commands) {
    await chargingWork(pool, async (db) => {
      await lockSessionGraph(db, c.session_id);
      await db.query(
        "UPDATE charging_commands SET status='submitted',deliveries=deliveries+1 WHERE id=$1 AND status IN ('pending','submitted')",
        [c.id],
      );
    });
    const receipt = await adapter.execute(c.id);
    if (receipt) await applyReceipt(pool, c.id);
  }
  const unfinished = (
    await pool.query(
      "SELECT id FROM charging_sessions WHERE status IN ('active','stopping') ORDER BY requested_at LIMIT 100",
    )
  ).rows;
  for (const { id } of unfinished) {
    await adapter.sample(id);
    await chargingWork(pool, async (db) => {
      const graph = await lockSessionGraph(db, id),
        { s } = graph;
      if (s.status !== "active") return;
      const delay = Number(
        (
          await db.query(
            "SELECT command_delay_ms FROM simulator_devices WHERE connector_id=$1",
            [s.connector_id],
          )
        ).rows[0].command_delay_ms,
      );
      const margin = Math.ceil(
        (Number(s.allocated_power_w) * (10000 + delay + 2000)) / 3600000,
      );
      const reason = !(await localPowerProof(db, graph))
        ? "local_limit"
        : (await databaseNow(db)) >= s.window_end
          ? "reservation_end"
          : Number(s.energy_budget_wh) - Number(s.energy_wh) <= margin
            ? "prepayment_budget"
            : null;
      if (reason) await enqueueStop(db, s, reason);
    });
  }
  const refunds = (
    await pool.query(
      "SELECT id FROM session_refunds WHERE status<>'succeeded' ORDER BY created_at LIMIT 20",
    )
  ).rows;
  for (const r of refunds)
    await recoverSessionRefund(pool, r.id, refundAdapter);
}
