import { Router } from "express";
import type { Database } from "../../db/pool.js";
import { HttpError } from "../../middleware/errors.js";
import { authenticate } from "../auth/middleware.js";
import { availabilityInput, validateInterval } from "./validation.js";
import { databaseNow } from "./service.js";

export function availabilityRoutes(pool: Database) {
  const router = Router();
  router.get("/:id/availability", authenticate(pool), async (req, res) => {
    if (req.identity!.role !== "driver")
      throw new HttpError(403, "Доступно только водителю.");
    const input = availabilityInput.parse(req.query);
    const start = new Date(input.start),
      end = new Date(start.getTime() + input.duration * 60000);
    const now = await databaseNow(pool);
    validateInterval(start, end, now);
    const station = (
      await pool.query(
        `SELECT id,operating_state,price_per_kwh_kopecks FROM stations WHERE id=$1 AND archived_at IS NULL`,
        [String(req.params.id)],
      )
    ).rows[0];
    if (!station) throw new HttpError(404, "Станция не найдена.");
    const profile = (
      await pool.query(
        "SELECT battery_capacity_kwh FROM driver_profiles WHERE user_id=$1",
        [req.identity!.id],
      )
    ).rows[0];
    if (!profile)
      throw new HttpError(
        409,
        "Заполните профиль водителя перед оценкой стоимости.",
      );
    const ports = (
      await pool.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE free)::int AS available,
       min(max_power_kw) FILTER (WHERE free)::float8 AS power FROM (
         SELECT c.max_power_kw, (c.operating_state='idle' AND $4::text='online' AND NOT EXISTS (
           SELECT 1 FROM connector_reservations r WHERE r.connector_id=c.id
           AND (r.state='confirmed' OR (r.state='held' AND r.expires_at>clock_timestamp()))
           AND tstzrange(r.start_at,r.end_at,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)')
         )) AS free FROM connectors c WHERE c.station_id=$1 AND c.type=$5 AND c.archived_at IS NULL
       ) candidates`,
        [station.id, start, end, station.operating_state, input.connector],
      )
    ).rows[0];
    const energy = ports.available
      ? Math.min(
          ((ports.power * input.duration) / 60) * 0.65,
          Number(profile.battery_capacity_kwh) * 0.3,
        )
      : null;
    // Same teaching estimate as the prototype, using server-owned profile/tariff and the lowest free port power.
    const amountKopecks =
      energy === null
        ? null
        : Math.round(energy * station.price_per_kwh_kopecks);
    res.json({
      stationId: station.id,
      connector: input.connector,
      start: start.toISOString(),
      end: end.toISOString(),
      duration: input.duration,
      available: ports.available,
      total: ports.total,
      estimatedAmount: amountKopecks === null ? null : amountKopecks / 100,
      estimatedAmountKopecks: amountKopecks,
      estimatedEnergyKwh:
        energy === null ? null : Math.round(energy * 1000) / 1000,
      estimateMethod: "power65-battery30",
      currency: "RUB",
      guaranteed: false,
      evaluatedAt: now.toISOString(),
      validUntil: new Date(
        Math.min(now.getTime() + 30000, start.getTime()),
      ).toISOString(),
    });
  });
  return router;
}
