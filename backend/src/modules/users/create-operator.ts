import { z } from "zod";
import { loadConfig } from "../../config/env.js";
import { createPool, transaction } from "../../db/pool.js";
import { email, password, personalFields } from "./validation.js";
import { hashPassword } from "../auth/security.js";

const pool = createPool(loadConfig().DATABASE_URL);
try {
  const input = z
    .object({
      email,
      name: personalFields.name,
      password,
      organizationId: z.uuid(),
    })
    .parse({
      email: process.env.OPERATOR_EMAIL,
      name: process.env.OPERATOR_NAME,
      password: process.env.OPERATOR_PASSWORD,
      organizationId: process.env.OPERATOR_ORGANIZATION_ID,
    });
  const hash = await hashPassword(input.password);
  await transaction(pool, async (db) => {
    const { rows } = await db.query(
      "INSERT INTO users(email_normalized,password_hash,name,role,organization_id) VALUES ($1,$2,$3,'operator',$4) RETURNING id",
      [input.email, hash, input.name, input.organizationId],
    );
    await db.query("INSERT INTO user_preferences(user_id) VALUES ($1)", [
      rows[0].id,
    ]);
  });
  console.log("Operator created");
} catch {
  console.error(
    "Operator was not created; check fields, organization and unique email",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
