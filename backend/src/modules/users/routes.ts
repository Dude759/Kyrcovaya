import { Router } from "express";
import type { Database } from "../../db/pool.js";
import { transaction } from "../../db/pool.js";
import { driverProfile, operatorProfile, preferences } from "./validation.js";
import { getUser, getPreferences } from "./repository.js";

const preferenceColumns = {
  bookingAlerts: "booking_alerts",
  receipts: "receipts",
  networkAlerts: "network_alerts",
  criticalAlerts: "critical_alerts",
  loadAlerts: "load_alerts",
  reports: "reports",
} as const;

export function userRoutes(pool: Database) {
  const router = Router();
  router.patch("/profile", async (req, res) => {
    const identity = req.identity!;
    const result = await transaction(pool, async (db) => {
      await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
        identity.id,
      ]);
      if (identity.role === "driver") {
        const input = driverProfile.parse(req.body);
        await db.query(
          "UPDATE users SET name=$1,email_normalized=$2,phone=$3 WHERE id=$4",
          [input.name, input.email, input.phone, identity.id],
        );
        await db.query(
          "UPDATE driver_profiles SET vehicle_name=$1,plate=$2,preferred_connector_type=$3,battery_capacity_kwh=$4 WHERE user_id=$5",
          [
            input.vehicle,
            input.plate,
            input.connector,
            input.battery,
            identity.id,
          ],
        );
      } else {
        const input = operatorProfile.parse(req.body);
        await db.query(
          "UPDATE users SET name=$1,email_normalized=$2,phone=$3 WHERE id=$4",
          [input.name, input.email, input.phone, identity.id],
        );
      }
      return getUser(db, identity.id);
    });
    res.json(result);
  });
  router.patch("/preferences", async (req, res) => {
    const input = preferences.parse(req.body);
    // Column identifiers come only from this fixed map, never from client text.
    const entries = Object.entries(input) as [
      keyof typeof preferenceColumns,
      boolean,
    ][];
    await pool.query(
      `UPDATE user_preferences SET ${entries.map(([key], i) => `${preferenceColumns[key]}=$${i + 1}`).join(",")} WHERE user_id=$${entries.length + 1}`,
      [...entries.map(([, value]) => value), req.identity!.id],
    );
    res.json(await getPreferences(pool, req.identity!.id));
  });
  return router;
}
