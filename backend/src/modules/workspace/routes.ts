import { Router } from "express";
import type { Database } from "../../db/pool.js";
import { transaction } from "../../db/pool.js";
import { listStations } from "../catalog/service.js";
import { getPreferences } from "../users/repository.js";
import { paymentDto } from "../payments/service.js";
import type { PaymentOptions } from "../payments/provider.js";

export function workspaceRoutes(
  pool: Database,
  paymentOptions?: PaymentOptions,
) {
  const router = Router();
  router.get("/workspace", async (req, res) => {
    const value = await transaction(pool, async (db) => {
      await db.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const identity = req.identity!;
      // Workspace is bounded by the Stage 2A stand size (<=200 stations).
      const { items, nextCursor } = await listStations(db, identity, {
        limit: 200,
      });
      if (nextCursor) throw new Error("Workspace catalog requires pagination");
      const organization = identity.organizationId
        ? (
            await db.query(
              "SELECT name,network_limit_kw FROM organizations WHERE id=$1",
              [identity.organizationId],
            )
          ).rows[0]
        : null;
      const orders =
        identity.role === "driver"
          ? (
              await db.query(
                "SELECT * FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
                [identity.id],
              )
            ).rows
          : [];
      const payments = await Promise.all(
        orders.map((p) => paymentDto(db, p, paymentOptions)),
      );
      const bookings =
        identity.role === "driver"
          ? (
              await db.query(
                "SELECT * FROM bookings WHERE user_id=$1 ORDER BY start_at DESC LIMIT 100",
                [identity.id],
              )
            ).rows.map((b) => ({
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
            }))
          : [];
      return {
        stations: items,
        preferences: await getPreferences(db, identity.id),
        organization: organization?.name ?? "",
        networkLimit: organization ? Number(organization.network_limit_kw) : 0,
        bookings,
        sessions: [],
        payments,
        events: [],
        forecast: null,
        stage: identity.role === "driver" ? "bookings" : "foundation",
      };
    });
    res.json(value);
  });
  return router;
}
