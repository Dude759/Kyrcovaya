import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { Database, Connection } from "../../db/pool.js";
import { transaction } from "../../db/pool.js";
import { HttpError } from "../../middleware/errors.js";
import { login, registration } from "../users/validation.js";
import { getUser } from "../users/repository.js";
import { authenticate } from "./middleware.js";
import {
  hashPassword,
  verifyPassword,
  newToken,
  hashToken,
} from "./security.js";

async function createSession(db: Connection, userId: string, ttl: number) {
  const token = newToken();
  await db.query(
    "INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()+ $3 * interval '1 second')",
    [userId, hashToken(token), ttl],
  );
  return { user: await getUser(db, userId), token };
}
export function authRoutes(pool: Database, ttl: number) {
  const router = Router();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { message: "Слишком много попыток. Повторите позже." },
  });
  router.post("/register", limiter, async (req, res) => {
    const input = registration.parse(req.body);
    const hash = await hashPassword(input.password);
    const result = await transaction(pool, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO users(email_normalized,password_hash,name,phone,role)
        VALUES ($1,$2,$3,$4,'driver') RETURNING id`,
        [input.email, hash, input.name, input.phone],
      );
      const id = rows[0].id;
      await db.query(
        "INSERT INTO driver_profiles(user_id,vehicle_name,plate,preferred_connector_type,battery_capacity_kwh) VALUES ($1,$2,$3,$4,$5)",
        [id, input.vehicle, input.plate, input.connector, input.battery],
      );
      await db.query("INSERT INTO user_preferences(user_id) VALUES ($1)", [id]);
      return createSession(db, id, ttl);
    });
    res.status(201).json(result);
  });
  // Same expensive hash path for unknown users avoids a trivial email timing oracle.
  const dummyHash = hashPassword(newToken());
  router.post("/login", limiter, async (req, res) => {
    const input = login.parse(req.body);
    const { rows } = await pool.query(
      "SELECT id,password_hash,role,disabled_at FROM users WHERE email_normalized=$1",
      [input.email],
    );
    const row = rows[0];
    const verified = await verifyPassword(
      input.password,
      row?.password_hash ?? (await dummyHash),
    );
    if (!row || !verified || row.disabled_at || row.role !== input.role)
      throw new HttpError(401, "Неверная почта, пароль или роль.");
    const result = await transaction(pool, async (db) => {
      const { rows: active } = await db.query(
        "SELECT id,password_hash,role,disabled_at FROM users WHERE id=$1 FOR UPDATE",
        [row.id],
      );
      if (
        !active[0] ||
        active[0].disabled_at ||
        active[0].password_hash !== row.password_hash ||
        active[0].role !== row.role
      )
        throw new HttpError(401, "Войдите снова.");
      return createSession(db, row.id, ttl);
    });
    res.json(result);
  });
  router.get("/me", authenticate(pool), async (req, res) => {
    res.json(await getUser(pool, req.identity!.id));
  });
  router.post("/logout", authenticate(pool), async (req, res) => {
    await pool.query("UPDATE auth_sessions SET revoked_at=now() WHERE id=$1", [
      req.identity!.sessionId,
    ]);
    res.sendStatus(204);
  });
  return router;
}
