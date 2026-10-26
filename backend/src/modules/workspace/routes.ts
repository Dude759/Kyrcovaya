import { Router } from "express";
import type { Database } from "../../db/pool.js";
import { transaction } from "../../db/pool.js";
import { listStations } from "../catalog/service.js";
import { getPreferences } from "../users/repository.js";

export function workspaceRoutes(pool: Database) {
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
      return {
        stations: items,
        preferences: await getPreferences(db, identity.id),
        organization: organization?.name ?? "",
        networkLimit: organization ? Number(organization.network_limit_kw) : 0,
        bookings: [],
        sessions: [],
        payments: [],
        events: [],
        forecast: null,
        stage: "foundation",
      };
    });
    res.json(value);
  });
  return router;
}
