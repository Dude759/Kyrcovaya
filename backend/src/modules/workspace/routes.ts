import { Router } from "express";
import type { Database } from "../../db/pool.js";
import { transaction } from "../../db/pool.js";
import { listStations } from "../catalog/service.js";
import { getPreferences } from "../users/repository.js";
import { paymentDto } from "../payments/service.js";
import type { PaymentOptions } from "../payments/provider.js";
import { listEvents } from "../operator/routes.js";
import { stationDetail } from "../catalog/service.js";
import { sessionDto } from "../sessions/service.js";
import { bookingDto, recoverBookingLifecycle } from "../bookings/service.js";

export function workspaceRoutes(
  pool: Database,
  paymentOptions?: PaymentOptions,
) {
  const router = Router();
  router.get("/workspace", async (req, res) => {
    if (req.identity!.role === "driver")
      await recoverBookingLifecycle(pool, req.identity!.id);
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
            ).rows
          : [];
      const historical = (
        await db.query(
          `SELECT DISTINCT station_id FROM bookings WHERE user_id=$1 UNION SELECT DISTINCT station_id FROM charging_sessions WHERE ($2='driver' AND user_id=$1) OR ($2='operator' AND organization_id=$3)`,
          [identity.id, identity.role, identity.organizationId ?? null],
        )
      ).rows;
      for (const h of historical)
        if (!items.some((s) => s.id === h.station_id))
          items.push(await stationDetail(db, identity, h.station_id));
      return {
        operatorManagement: identity.role === "operator",
        stations: items,
        preferences: await getPreferences(db, identity.id),
        organization: organization?.name ?? "",
        networkLimit: organization ? Number(organization.network_limit_kw) : 0,
        bookings: await Promise.all(bookings.map((b) => bookingDto(db, b))),
        sessions: await Promise.all(
          (
            await db.query(
              `SELECT * FROM charging_sessions WHERE ($1='driver' AND user_id=$2) OR ($1='operator' AND organization_id=$3) ORDER BY requested_at DESC LIMIT 100`,
              [identity.role, identity.id, identity.organizationId ?? null],
            )
          ).rows.map((s) => sessionDto(db, s)),
        ),
        charging: true,
        payments,
        events:
          identity.role === "operator"
            ? (await listEvents(db, identity.organizationId!)).items
            : [],
        forecast: null,
        stage: identity.role === "driver" ? "bookings" : "foundation",
      };
    });
    res.json(value);
  });
  return router;
}
