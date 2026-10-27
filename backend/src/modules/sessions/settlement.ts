import type { PoolClient } from "pg";
import { transaction, type Database } from "../../db/pool.js";
import { confirmTestRefund } from "../payments/finalization.js";

export async function settleSession(
  db: PoolClient,
  s: any,
  command: any,
  receipt: any,
  status: "completed" | "failed",
  reason: string,
) {
  const measurement = (
    await db.query(
      "SELECT * FROM session_measurements WHERE id=$1 AND session_id=$2",
      [receipt.measurement_id, s.id],
    )
  ).rows[0];
  if (!measurement?.final || (command.kind === "stop" && !receipt.accepted))
    throw new Error("Confirmed final measurement required");
  const energy = Number(measurement.energy_wh),
    cost = Math.floor((energy * Number(s.tariff_kopecks) + 999) / 1000),
    unused = Number(s.prepaid_kopecks) - cost;
  if (unused < 0) throw new Error("Metering exceeded prepayment");
  const settlement = (
    await db.query(
      `INSERT INTO session_settlements(session_id,payment_id,funding_attempt_id,energy_wh,tariff_kopecks,prepaid_kopecks,final_cost_kopecks,unused_kopecks,final_measurement_id,terminal_command_id,reason)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        s.id,
        s.payment_id,
        s.funding_attempt_id,
        energy,
        s.tariff_kopecks,
        s.prepaid_kopecks,
        cost,
        unused,
        measurement.id,
        command.id,
        reason,
      ],
    )
  ).rows[0];
  await db.query(
    `UPDATE charging_sessions SET status=$2,ended_at=(SELECT confirmed_at FROM simulator_command_receipts WHERE command_id=$3),stop_reason=$4 WHERE id=$1`,
    [s.id, status, command.id, reason],
  );
  if (status === "failed" || !s.started_at) {
    await db.query(
      "UPDATE bookings SET status='cancelled' WHERE id=$1 AND status='confirmed'",
      [s.booking_id],
    );
    await db.query(
      "UPDATE connector_reservations SET state='released' WHERE booking_id=$1 AND state='confirmed'",
      [s.booking_id],
    );
  }
  if (unused > 0)
    await db.query(
      `INSERT INTO session_refunds(session_id,settlement_id,payment_id,attempt_id,amount_kopecks) VALUES($1,$2,$3,$4,$5) ON CONFLICT(session_id) DO NOTHING`,
      [s.id, settlement.id, s.payment_id, s.funding_attempt_id, unused],
    );
}
export const confirmTestSessionRefund = (pool: Database, id: string) =>
  confirmTestRefund(pool, id, "session");
export async function recoverSessionRefund(
  pool: Database,
  id: string,
  adapter = confirmTestSessionRefund,
) {
  const candidate = (
    await pool.query("SELECT payment_id FROM session_refunds WHERE id=$1", [id])
  ).rows[0];
  if (!candidate) return;
  const intent = await transaction(pool, async (db) => {
    await db.query("SELECT id FROM payments WHERE id=$1 FOR UPDATE", [
      candidate.payment_id,
    ]);
    const row = (
      await db.query("SELECT * FROM session_refunds WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0];
    if (row.status === "succeeded") return null;
    return (
      await db.query(
        "UPDATE session_refunds SET status='submitted',submitted_at=COALESCE(submitted_at,clock_timestamp()),deliveries=deliveries+1 WHERE id=$1 RETURNING *",
        [id],
      )
    ).rows[0];
  });
  if (!intent) return;
  const receipt = await adapter(pool, id);
  if (
    receipt.provider_refund_id !== intent.provider_refund_id ||
    Number(receipt.amount_kopecks) !== Number(intent.amount_kopecks)
  )
    throw new Error("Session refund receipt mismatch");
  await transaction(pool, async (db) => {
    await db.query("SELECT id FROM payments WHERE id=$1 FOR UPDATE", [
      candidate.payment_id,
    ]);
    const updated = await db.query(
      `UPDATE session_refunds r SET status='succeeded',confirmed_at=t.confirmed_at FROM test_session_refund_receipts t
    WHERE r.id=$1 AND t.refund_id=r.id AND t.provider_refund_id=r.provider_refund_id AND t.amount_kopecks=r.amount_kopecks`,
      [id],
    );
    if (updated.rowCount !== 1)
      throw new Error("Durable session refund receipt missing");
  });
}
