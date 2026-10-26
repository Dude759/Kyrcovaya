import { z } from "zod";
import type { PoolClient } from "pg";
import { transaction, type Database, type Connection } from "../../db/pool.js";
import { HttpError } from "../../middleware/errors.js";
import { holdInput, validateInterval } from "./validation.js";

type ReservationRow = {
  id: string;
  connector_id: string;
  start_at: Date;
  end_at: Date;
  state: "held" | "confirmed" | "released" | "expired";
  expires_at: Date | null;
  created_at: Date;
};
function dto(row: ReservationRow) {
  return {
    id: row.id,
    connectorId: row.connector_id,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    state: row.state,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}
export async function databaseNow(db: Connection): Promise<Date> {
  return (await db.query("SELECT clock_timestamp() AS now")).rows[0].now;
}

// Only DB work may be retried here; payment/device side effects do not belong in this callback.
async function reservationTransaction<T>(
  pool: Database,
  operation: (db: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await transaction(pool, operation);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23P01")
        throw new HttpError(409, "Порт уже занят на выбранный интервал.");
      if (!["40P01", "40001"].includes(code ?? "")) throw error;
      if (attempt === 2)
        throw new HttpError(
          409,
          "Конкурентное изменение. Повторите выбор порта.",
        );
    }
  }
}

// Caller must own an open transaction. Stage 3B can include this operation in payment creation.
export async function createHoldInTransaction(db: PoolClient, raw: unknown) {
  const input = holdInput.parse(raw);
  const start = new Date(input.startAt),
    end = new Date(input.endAt);
  validateInterval(start, end, await databaseNow(db));
  // Common lock order: station -> physical ports (UUID order) -> reservations.
  const station = (
    await db.query(
      `SELECT operating_state FROM stations WHERE id=$1 AND organization_id=$2 AND archived_at IS NULL FOR SHARE`,
      [input.stationId, input.organizationId],
    )
  ).rows[0];
  if (!station) throw new HttpError(404, "Станция не найдена в организации.");
  if (station.operating_state !== "online")
    throw new HttpError(409, "Станция недоступна.");
  // Small teaching catalog: lock the candidate set instead of skipping a temporarily locked free port.
  const ports = (
    await db.query(
      `SELECT id,operating_state FROM connectors WHERE station_id=$1 AND type=$2 AND archived_at IS NULL
     AND ($3::uuid IS NULL OR id=$3) ORDER BY id FOR UPDATE`,
      [input.stationId, input.connector, input.connectorId ?? null],
    )
  ).rows;
  if (!ports.length) throw new HttpError(404, "Разъём не найден на станции.");
  const ids = ports.map((p) => p.id as string);
  // now() must not appear in the partial exclusion predicate. Expiry is an explicit state transition.
  await db.query(
    `UPDATE connector_reservations SET state='expired' WHERE connector_id=ANY($1::uuid[])
     AND state='held' AND expires_at <= clock_timestamp()`,
    [ids],
  );
  const free = (
    await db.query(
      `SELECT c.id FROM connectors c WHERE c.id=ANY($1::uuid[]) AND c.operating_state='idle'
     AND NOT EXISTS (SELECT 1 FROM connector_reservations r WHERE r.connector_id=c.id
       AND r.state IN ('held','confirmed') AND tstzrange(r.start_at,r.end_at,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)'))
     ORDER BY c.id LIMIT 1`,
      [ids, start, end],
    )
  ).rows[0];
  if (!free)
    throw new HttpError(409, "Свободного порта на выбранный интервал нет.");
  const now = await databaseNow(db);
  // Revalidate after waiting for locks, not only at request arrival.
  validateInterval(start, end, now);
  const expires = new Date(
    Math.min(now.getTime() + input.ttlSeconds * 1000, start.getTime()),
  );
  const row = (
    await db.query<ReservationRow>(
      `INSERT INTO connector_reservations(connector_id,start_at,end_at,expires_at,created_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [free.id, start, end, expires, now],
    )
  ).rows[0];
  return dto(row);
}

export function createHold(pool: Database, raw: unknown) {
  return reservationTransaction(pool, (db) => createHoldInTransaction(db, raw));
}

// Internal only: there is no HTTP release/confirm/hold endpoint in Stage 3A.
export async function releaseHold(
  pool: Database,
  organizationId: string,
  id: string,
) {
  z.uuid().parse(organizationId);
  z.uuid().parse(id);
  return reservationTransaction(pool, async (db) => {
    const target = (
      await db.query(
        `SELECT c.station_id,c.id AS connector_id FROM connector_reservations r
       JOIN connectors c ON c.id=r.connector_id JOIN stations s ON s.id=c.station_id
       WHERE r.id=$1 AND s.organization_id=$2`,
        [id, organizationId],
      )
    ).rows[0];
    if (!target) throw new HttpError(404, "Резерв не найден.");
    const station = await db.query(
      "SELECT id FROM stations WHERE id=$1 AND organization_id=$2 FOR SHARE",
      [target.station_id, organizationId],
    );
    if (!station.rows.length) throw new HttpError(404, "Резерв не найден.");
    const port = await db.query(
      "SELECT id FROM connectors WHERE id=$1 AND station_id=$2 FOR UPDATE",
      [target.connector_id, target.station_id],
    );
    if (!port.rows.length) throw new HttpError(404, "Резерв не найден.");
    const row = (
      await db.query<ReservationRow>(
        "SELECT * FROM connector_reservations WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (row.state === "confirmed")
      throw new HttpError(
        409,
        "Подтверждённая бронь требует отдельной отмены.",
      );
    if (row.state === "held") {
      const updated = (
        await db.query<ReservationRow>(
          `UPDATE connector_reservations SET state=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'released' END
         WHERE id=$1 RETURNING *`,
          [id],
        )
      ).rows[0];
      return dto(updated);
    }
    return dto(row);
  });
}
