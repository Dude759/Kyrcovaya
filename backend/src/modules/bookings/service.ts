import type { PoolClient } from "pg";
import { transaction, type Database } from "../../db/pool.js";
import { HttpError } from "../../middleware/errors.js";
import { databaseNow } from "../reservations/service.js";
import { chargingWork, lockBookingGraph } from "../sessions/graph.js";
import { confirmTestRefund } from "../payments/finalization.js";

export async function bookingDto(db: PoolClient, b: any) {
  const closure = (
    await db.query("SELECT * FROM booking_closures WHERE booking_id=$1", [b.id])
  ).rows[0];
  const refund = (
    await db.query("SELECT * FROM booking_refunds WHERE booking_id=$1", [b.id])
  ).rows[0];
  const session = (
    await db.query(
      "SELECT id,status FROM charging_sessions WHERE booking_id=$1",
      [b.id],
    )
  ).rows[0];
  return {
    id: b.id,
    userId: b.user_id,
    paymentId: b.payment_id,
    reservationId: b.reservation_id,
    stationId: b.station_id,
    connectorId: b.connector_id,
    connector: b.connector_type,
    start: b.start_at.toISOString(),
    duration: (b.end_at - b.start_at) / 60000,
    amount: Number(b.amount_kopecks) / 100,
    payment: b.method,
    status: b.status,
    createdAt: b.created_at.toISOString(),
    closureReason:
      closure?.reason ??
      (b.status === "cancelled" && session ? "session" : null),
    closedAt: closure?.closed_at.toISOString() ?? null,
    sessionId: session?.id ?? null,
    sessionStatus: session?.status ?? null,
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

async function closeBooking(
  pool: Database,
  id: string,
  userId: string,
  requested: "driver" | "no_show",
) {
  return chargingWork(pool, async (db) => {
    const { b, p, reservation } = await lockBookingGraph(db, id, userId);
    const closure = (
      await db.query("SELECT * FROM booking_closures WHERE booking_id=$1", [id])
    ).rows[0];
    if (closure) return bookingDto(db, b);
    // ALL historical session states matter, including failed and completed without a confirmed start.
    const session = (
      await db.query(
        "SELECT id FROM charging_sessions WHERE booking_id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (session || b.status !== "confirmed") {
      if (requested === "no_show") return null;
      throw new HttpError(
        409,
        "У брони уже есть зарядная сессия. Остановка и возврат выполняются в сессии.",
      );
    }
    const now = await databaseNow(db); // after every graph lock, never transaction-start now()
    const deadline = Math.min(
      b.start_at.getTime() + 15 * 60000,
      b.end_at.getTime(),
    );
    if (requested === "no_show" && now.getTime() < deadline) return null;
    if (p.status !== "succeeded" || reservation.state !== "confirmed")
      throw new HttpError(409, "Несогласованное состояние оплаченной брони.");
    const reason = now.getTime() >= deadline ? "no_show" : requested;
    await db.query(
      "INSERT INTO booking_closures(booking_id,reason,closed_at) VALUES($1,$2,$3)",
      [id, reason, now],
    );
    await db.query("UPDATE bookings SET status=$2 WHERE id=$1", [
      id,
      reason === "no_show" ? "expired" : "cancelled",
    ]);
    await db.query("UPDATE connector_reservations SET state=$2 WHERE id=$1", [
      reservation.id,
      reason === "no_show" ? "expired" : "released",
    ]);
    await db.query(
      "INSERT INTO booking_refunds(booking_id,payment_id,attempt_id,amount_kopecks) VALUES($1,$2,$3,$4)",
      [id, p.id, b.payment_attempt_id, b.amount_kopecks],
    );
    return bookingDto(
      db,
      (await db.query("SELECT * FROM bookings WHERE id=$1", [id])).rows[0],
    );
  });
}
export function cancelBooking(pool: Database, userId: string, id: string) {
  return closeBooking(pool, id, userId, "driver");
}
export const confirmTestBookingRefund = (pool: Database, id: string) =>
  confirmTestRefund(pool, id, "booking");
export async function recoverBookingRefund(
  pool: Database,
  id: string,
  adapter = confirmTestBookingRefund,
) {
  const candidate = (
    await pool.query("SELECT payment_id FROM booking_refunds WHERE id=$1", [id])
  ).rows[0];
  if (!candidate) return;
  const intent = await transaction(pool, async (db) => {
    await db.query("SELECT id FROM payments WHERE id=$1 FOR UPDATE", [
      candidate.payment_id,
    ]);
    const r = (
      await db.query("SELECT * FROM booking_refunds WHERE id=$1 FOR UPDATE", [
        id,
      ])
    ).rows[0];
    if (r.status === "succeeded") return null;
    return (
      await db.query(
        "UPDATE booking_refunds SET status='submitted',submitted_at=COALESCE(submitted_at,clock_timestamp()),deliveries=deliveries+1 WHERE id=$1 RETURNING *",
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
    throw new Error("Booking refund receipt mismatch");
  await transaction(pool, async (db) => {
    await db.query("SELECT id FROM payments WHERE id=$1 FOR UPDATE", [
      candidate.payment_id,
    ]);
    const updated = await db.query(
      `UPDATE booking_refunds r SET status='succeeded',confirmed_at=t.confirmed_at FROM test_booking_refund_receipts t
      WHERE r.id=$1 AND t.refund_id=r.id AND t.provider_refund_id=r.provider_refund_id AND t.amount_kopecks=r.amount_kopecks`,
      [id],
    );
    if (updated.rowCount !== 1)
      throw new Error("Durable booking refund receipt missing");
  });
}
export async function recoverBookingLifecycle(
  pool: Database,
  userId?: string,
  adapter = confirmTestBookingRefund,
) {
  const candidates = (
    await pool.query(
      `SELECT b.id,b.user_id FROM bookings b WHERE b.status='confirmed'
    AND ($1::uuid IS NULL OR b.user_id=$1) AND booking_start_deadline(b.start_at,b.end_at)<=clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM charging_sessions s WHERE s.booking_id=b.id) ORDER BY b.start_at LIMIT 20`,
      [userId ?? null],
    )
  ).rows;
  for (const b of candidates)
    await closeBooking(pool, b.id, b.user_id, "no_show");
  const refunds = (
    await pool.query(
      `SELECT r.id FROM booking_refunds r JOIN bookings b ON b.id=r.booking_id WHERE r.status<>'succeeded'
    AND ($1::uuid IS NULL OR b.user_id=$1) ORDER BY r.created_at LIMIT 20`,
      [userId ?? null],
    )
  ).rows;
  for (const r of refunds) await recoverBookingRefund(pool, r.id, adapter);
}
