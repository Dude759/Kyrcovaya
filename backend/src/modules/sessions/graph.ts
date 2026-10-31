import type { PoolClient } from "pg";
import { transaction, type Database } from "../../db/pool.js";
import { HttpError } from "../../middleware/errors.js";
export async function chargingWork<T>(
  pool: Database,
  operation: (db: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++)
    try {
      return await transaction(pool, operation);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (["40P01", "40001"].includes(code ?? "") && attempt < 2) continue;
      if (["23505", "23P01", "40P01", "40001"].includes(code ?? ""))
        throw new HttpError(
          409,
          "Порт или водитель уже занят другой операцией.",
        );
      throw error;
    }
}
export async function lockBookingGraph(
  db: PoolClient,
  bookingId: string,
  userId: string,
) {
  const candidate = (
    await db.query("SELECT * FROM bookings WHERE id=$1 AND user_id=$2", [
      bookingId,
      userId,
    ])
  ).rows[0];
  if (!candidate) throw new HttpError(404, "Бронь не найдена.");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `dispatch:${candidate.organization_id}`,
  ]);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `charging-driver:${userId}`,
  ]);
  const p = (
    await db.query("SELECT * FROM payments WHERE id=$1 FOR UPDATE", [
      candidate.payment_id,
    ])
  ).rows[0];
  // A station write lock serializes reservations of simulator power across its physical ports.
  const station = (
    await db.query("SELECT * FROM stations WHERE id=$1 FOR UPDATE", [
      candidate.station_id,
    ])
  ).rows[0];
  const port = (
    await db.query("SELECT * FROM connectors WHERE id=$1 FOR UPDATE", [
      candidate.connector_id,
    ])
  ).rows[0];
  const reservation = (
    await db.query(
      "SELECT * FROM connector_reservations WHERE id=$1 FOR UPDATE",
      [candidate.reservation_id],
    )
  ).rows[0];
  const b = (
    await db.query("SELECT * FROM bookings WHERE id=$1 FOR UPDATE", [bookingId])
  ).rows[0];
  return { p, station, port, reservation, b };
}
export async function lockSessionGraph(db: PoolClient, id: string) {
  const row = (
    await db.query(
      "SELECT booking_id,user_id FROM charging_sessions WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "Сессия не найдена.");
  const graph = await lockBookingGraph(db, row.booking_id, row.user_id);
  const s = (
    await db.query("SELECT * FROM charging_sessions WHERE id=$1 FOR UPDATE", [
      id,
    ])
  ).rows[0];
  return { ...graph, s };
}
export async function localPowerProof(
  db: PoolClient,
  graph: Awaited<ReturnType<typeof lockSessionGraph>>,
) {
  const { s, station, port } = graph;
  const allocated = Number(
    (
      await db.query(
        "SELECT COALESCE(sum(allocated_power_w),0) total FROM charging_sessions WHERE station_id=$1 AND status IN ('starting','active','stopping')",
        [s.station_id],
      )
    ).rows[0].total,
  );
  return (
    !station.archived_at &&
    !port.archived_at &&
    station.operating_state === "online" &&
    port.operating_state === "idle" &&
    Number(s.allocated_power_w) <= Number(port.max_power_kw) * 1000 &&
    allocated <=
      Math.floor(
        Math.min(Number(station.max_power_kw), Number(station.limit_kw)) * 1000,
      )
  );
}
