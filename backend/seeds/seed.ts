import { readFile } from "node:fs/promises";
import { z } from "zod";
import { transaction, type Database } from "../src/db/pool.js";
import { hashPassword } from "../src/modules/auth/security.js";
import { password, connectorType } from "../src/modules/users/validation.js";

export const demoOrganizationId = "00000000-0000-4000-8000-000000000001";
const catalogSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    address: z.string(),
    district: z.string(),
    coordinates: z.tuple([z.number(), z.number()]),
    maxPowerKw: z.number(),
    limitKw: z.number(),
    price: z.number(),
    state: z.enum(["online", "offline", "service"]),
    ports: z.array(
      z.tuple([connectorType, z.number(), z.number().int().positive()]),
    ),
  }),
);

export async function seed(
  pool: Database,
  operatorPassword: string,
  driverPassword: string,
) {
  password.parse(operatorPassword);
  password.parse(driverPassword);
  const catalog = catalogSchema.parse(
    JSON.parse(await readFile("seeds/catalog.json", "utf8")),
  );
  const [operatorHash, driverHash] = await Promise.all([
    hashPassword(operatorPassword),
    hashPassword(driverPassword),
  ]);
  await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(7241032)");
    await db.query(
      "INSERT INTO organizations(id,name,network_limit_kw) VALUES ($1,$2,4000) ON CONFLICT (id) DO NOTHING",
      [demoOrganizationId, "Энерготранспорт — учебная сеть"],
    );
    for (const [email, name, role, hash] of [
      [
        "operator@energotransport.test",
        "Сергей Оператор",
        "operator",
        operatorHash,
      ],
      ["driver@energotransport.test", "Алексей Водитель", "driver", driverHash],
      ["driver2@energotransport.test", "Мария Водитель", "driver", driverHash],
    ]) {
      await db.query(
        `INSERT INTO users(email_normalized,password_hash,name,phone,role,organization_id)
        VALUES ($1,$2,$3,'',$4,$5) ON CONFLICT (email_normalized) DO NOTHING`,
        [
          email,
          hash,
          name,
          role,
          role === "operator" ? demoOrganizationId : null,
        ],
      );
      const { rows } = await db.query(
        "SELECT id,role,organization_id FROM users WHERE email_normalized=$1",
        [email],
      );
      const user = rows[0];
      if (
        user.role !== role ||
        (role === "operator" && user.organization_id !== demoOrganizationId)
      )
        throw new Error("Seed account conflicts with existing identity");
      await db.query(
        "INSERT INTO user_preferences(user_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [user.id],
      );
      if (role === "driver")
        await db.query(
          `INSERT INTO driver_profiles(user_id,vehicle_name,plate,preferred_connector_type,battery_capacity_kwh)
        VALUES ($1,'Электромобиль','','CCS2',75) ON CONFLICT DO NOTHING`,
          [user.id],
        );
    }
    for (const station of catalog) {
      await db.query(
        `INSERT INTO stations(id,organization_id,name,address,district,longitude,latitude,max_power_kw,limit_kw,price_per_kwh_kopecks,operating_state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [
          station.id,
          demoOrganizationId,
          station.name,
          station.address,
          station.district,
          ...station.coordinates,
          station.maxPowerKw,
          station.limitKw,
          Math.round(station.price * 100),
          station.state,
        ],
      );
      const owner = await db.query(
        "SELECT organization_id FROM stations WHERE id=$1",
        [station.id],
      );
      if (owner.rows[0].organization_id !== demoOrganizationId)
        throw new Error("Seed station conflicts with existing organization");
      for (const [type, power, count] of station.ports)
        for (let i = 1; i <= count; i++) {
          await db.query(
            `INSERT INTO connectors(station_id,label,type,max_power_kw,operating_state) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (station_id,label) DO NOTHING`,
            [
              station.id,
              `${type}-${power}-${i}`,
              type,
              power,
              station.state === "online" ? "idle" : station.state,
            ],
          );
        }
    }
  });
}
