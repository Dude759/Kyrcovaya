import type { Connection } from "../../db/pool.js";
import { HttpError } from "../../middleware/errors.js";

export const userSelect = `SELECT u.id,u.email_normalized,u.name,u.phone,u.role,u.organization_id,u.disabled_at,
  d.vehicle_name,d.plate,d.preferred_connector_type,d.battery_capacity_kwh
  FROM users u LEFT JOIN driver_profiles d ON d.user_id=u.id`;
type UserRow = {
  id: string;
  email_normalized: string;
  name: string;
  phone: string;
  role: "driver" | "operator";
  organization_id: string | null;
  disabled_at: Date | null;
  vehicle_name: string | null;
  plate: string | null;
  preferred_connector_type: string | null;
  battery_capacity_kwh: string | null;
};
export function userDto(row: UserRow) {
  return {
    id: row.id as string,
    name: row.name as string,
    email: row.email_normalized as string,
    phone: row.phone as string,
    role: row.role as "driver" | "operator",
    ...(row.role === "driver"
      ? {
          vehicle: row.vehicle_name as string,
          plate: row.plate as string,
          connector: row.preferred_connector_type as string,
          battery: Number(row.battery_capacity_kwh),
        }
      : {}),
  };
}
export async function getUser(db: Connection, id: string) {
  const { rows } = await db.query<UserRow>(
    `${userSelect} WHERE u.id=$1 AND u.disabled_at IS NULL`,
    [id],
  );
  if (!rows[0]) throw new HttpError(401, "Необходимо войти в аккаунт.");
  return userDto(rows[0]);
}
export async function getPreferences(db: Connection, id: string) {
  const { rows } = await db.query(
    `SELECT booking_alerts AS "bookingAlerts", receipts, network_alerts AS "networkAlerts",
    critical_alerts AS "criticalAlerts", load_alerts AS "loadAlerts", reports FROM user_preferences WHERE user_id=$1`,
    [id],
  );
  return rows[0];
}
