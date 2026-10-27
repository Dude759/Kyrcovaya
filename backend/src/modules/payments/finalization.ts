import type { PoolClient } from "pg";
import { transaction, type Database } from "../../db/pool.js";
import {
  databaseNow,
  releaseHoldInTransaction,
} from "../reservations/service.js";

// Internal transaction operation. Only a verified, persisted succeeded inbox event may enter here.
// Lock order is payment -> station -> connector -> reservation -> attempt/event -> compensation.
export async function finalizePayment(
  db: PoolClient,
  paymentId: string,
  eventId: string,
) {
  const p = (
    await db.query("SELECT * FROM payments WHERE id=$1 FOR UPDATE", [paymentId])
  ).rows[0];
  const event = (
    await db.query(
      `SELECT e.*,a.payment_id FROM payment_events e JOIN payment_attempts a ON a.id=e.attempt_id
    WHERE e.id=$1 AND e.kind='succeeded' AND a.payment_id=$2`,
      [eventId, paymentId],
    )
  ).rows[0];
  if (!p || !event) throw new Error("Verified success inbox entry required");
  const booking = (
    await db.query("SELECT * FROM bookings WHERE payment_id=$1", [p.id])
  ).rows[0];
  if (booking?.payment_attempt_id === event.attempt_id) return "finalized";
  const station = (
    await db.query(
      "SELECT * FROM stations WHERE id=$1 AND organization_id=$2 FOR SHARE",
      [p.station_id, p.organization_id],
    )
  ).rows[0];
  const port = (
    await db.query(
      "SELECT * FROM connectors WHERE id=$1 AND station_id=$2 FOR UPDATE",
      [p.connector_id, p.station_id],
    )
  ).rows[0];
  const r = (
    await db.query(
      "SELECT * FROM connector_reservations WHERE payment_id=$1 FOR UPDATE",
      [p.id],
    )
  ).rows[0];
  const a = (
    await db.query("SELECT * FROM payment_attempts WHERE id=$1 FOR UPDATE", [
      event.attempt_id,
    ])
  ).rows[0];
  const latest = (
    await db.query(
      "SELECT id FROM payment_attempts WHERE payment_id=$1 ORDER BY attempt_no DESC LIMIT 1",
      [p.id],
    )
  ).rows[0];
  if (
    !r ||
    !station ||
    !port ||
    r.connector_id !== p.connector_id ||
    port.type !== p.requested_connector_type ||
    r.start_at.getTime() !== p.start_at.getTime() ||
    r.end_at.getTime() !== p.end_at.getTime()
  )
    throw new Error("Inconsistent payment reservation snapshot");
  await db.query(
    "UPDATE payment_attempts SET status='succeeded',resolved_at=COALESCE(resolved_at,clock_timestamp()) WHERE id=$1",
    [event.attempt_id],
  );
  await db.query(
    "UPDATE payments SET provider_success_received_at=COALESCE(provider_success_received_at,clock_timestamp()) WHERE id=$1",
    [p.id],
  );
  const now = await databaseNow(db);
  let reason = booking
    ? "extra_success"
    : p.expires_at <= now || r.expires_at <= now || r.state === "expired"
      ? "hold_expired"
      : r.state !== "held" || p.status !== "pending"
        ? "hold_released"
        : latest.id !== a.id
          ? "attempt_not_current"
          : station.archived_at ||
              station.operating_state !== "online" ||
              port.archived_at ||
              port.operating_state !== "idle"
            ? "port_unavailable"
            : null;
  if (!reason) {
    // Exclusion is the last guard even if an external actor bypassed the service locking convention.
    await db.query("SAVEPOINT confirm_booking");
    try {
      const b = (
        await db.query(
          `INSERT INTO bookings(payment_id,reservation_id,payment_attempt_id,user_id,organization_id,station_id,connector_id,connector_type,start_at,end_at,amount_kopecks,method)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [
            p.id,
            r.id,
            a.id,
            p.user_id,
            p.organization_id,
            p.station_id,
            p.connector_id,
            p.requested_connector_type,
            p.start_at,
            p.end_at,
            p.amount_kopecks,
            p.method,
          ],
        )
      ).rows[0];
      await db.query(
        "UPDATE connector_reservations SET state='confirmed',booking_id=$2 WHERE id=$1",
        [r.id, b.id],
      );
      await db.query(
        "UPDATE payments SET status='succeeded',booking_id=$2,finalized_at=clock_timestamp(),finalization_reason=NULL,requires_reconciliation=false WHERE id=$1",
        [p.id, b.id],
      );
      await db.query("RELEASE SAVEPOINT confirm_booking");
      return "finalized";
    } catch (error) {
      await db.query("ROLLBACK TO SAVEPOINT confirm_booking");
      if ((error as { code?: string }).code !== "23P01") throw error;
      reason = "port_conflict";
    }
  }
  if (!booking) {
    await releaseHoldInTransaction(db, p.organization_id, r.id);
    await db.query(
      "UPDATE payment_attempts SET status='cancelled',resolved_at=clock_timestamp() WHERE payment_id=$1 AND status='pending' AND id<>$2",
      [p.id, a.id],
    );
  }
  await db.query(
    `INSERT INTO payment_compensations(payment_id,attempt_id,amount_kopecks,reason) VALUES($1,$2,$3,$4) ON CONFLICT(attempt_id) DO NOTHING`,
    [p.id, a.id, p.amount_kopecks, reason],
  );
  await db.query(
    `UPDATE payments SET status=CASE WHEN status='succeeded' THEN status ELSE 'failed' END,
    failure_code=CASE WHEN status='succeeded' THEN failure_code WHEN $2='hold_expired' THEN 'expired' ELSE COALESCE(failure_code,'provider_failed') END,
    finalization_reason=COALESCE(finalization_reason,$2),requires_reconciliation=EXISTS(
      SELECT 1 FROM payment_compensations c WHERE c.payment_id=$1 AND c.status<>'succeeded'
    ) WHERE id=$1`,
    [p.id, reason],
  );
  return "compensation_pending";
}

// Adapter confirmation is its own durable effect, outside the finalization transaction.
// Retrying the same refund ID after a crash returns the same receipt; no money moves.
export async function confirmTestRefund(
  pool: Database,
  compensationId: string,
  kind: "compensation" | "session" | "booking" = "compensation",
) {
  const table =
    kind === "booking"
      ? "booking_refunds"
      : kind === "session"
        ? "session_refunds"
        : "payment_compensations";
  const ledger =
    kind === "booking"
      ? "test_booking_refund_receipts"
      : kind === "session"
        ? "test_session_refund_receipts"
        : "test_refund_receipts";
  const reference = kind !== "compensation" ? "refund_id" : "compensation_id";
  return transaction(pool, async (db) => {
    const c = (
      await db.query(`SELECT * FROM ${table} WHERE id=$1`, [compensationId])
    ).rows[0];
    if (!c || !["submitted", "succeeded"].includes(c.status))
      throw new Error("Refund has not been submitted");
    return (
      await db.query(
        `INSERT INTO ${ledger}(provider_refund_id,${reference},amount_kopecks)
      VALUES($1,$2,$3) ON CONFLICT(provider_refund_id) DO UPDATE SET provider_refund_id=EXCLUDED.provider_refund_id RETURNING *`,
        [c.provider_refund_id, c.id, c.amount_kopecks],
      )
    ).rows[0];
  });
}

export async function recoverCompensation(
  pool: Database,
  id: string,
  adapter = confirmTestRefund,
) {
  const candidate = (
    await pool.query(
      "SELECT payment_id FROM payment_compensations WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!candidate) return;
  const c = await transaction(pool, async (db) => {
    await db.query("SELECT id FROM payments WHERE id=$1 FOR UPDATE", [
      candidate.payment_id,
    ]);
    const row = (
      await db.query(
        "SELECT * FROM payment_compensations WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (row.status === "succeeded") return null;
    return (
      await db.query(
        "UPDATE payment_compensations SET status='submitted',submitted_at=COALESCE(submitted_at,clock_timestamp()),deliveries=deliveries+1 WHERE id=$1 RETURNING *",
        [id],
      )
    ).rows[0];
  });
  if (!c) return;
  const receipt = await adapter(pool, id);
  if (
    receipt.provider_refund_id !== c.provider_refund_id ||
    Number(receipt.amount_kopecks) !== Number(c.amount_kopecks)
  )
    throw new Error("Refund adapter confirmation mismatch");
  await transaction(pool, async (db) => {
    await db.query("SELECT id FROM payments WHERE id=$1 FOR UPDATE", [
      candidate.payment_id,
    ]);
    const confirmed = await db.query(
      `UPDATE payment_compensations c SET status='succeeded',confirmed_at=t.confirmed_at
      FROM test_refund_receipts t WHERE c.id=$1 AND t.compensation_id=c.id AND t.provider_refund_id=c.provider_refund_id AND t.amount_kopecks=c.amount_kopecks`,
      [id],
    );
    if (confirmed.rowCount !== 1)
      throw new Error("Durable refund receipt missing");
    await db.query(
      `UPDATE payments SET requires_reconciliation=EXISTS(SELECT 1 FROM payment_compensations WHERE payment_id=$1 AND status<>'succeeded') WHERE id=$1`,
      [candidate.payment_id],
    );
  });
}
