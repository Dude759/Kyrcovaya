import { Router } from "express";
import { z } from "zod";
import type { Database } from "../../db/pool.js";
import { HttpError } from "../../middleware/errors.js";
import { idempotencyKey, emptyBody } from "../payments/validation.js";
import { startSession, stopSession, getSession } from "./service.js";
export function sessionRoutes(pool: Database) {
  const router = Router();
  router.post("/", async (req, res) => {
    if (req.identity!.role !== "driver")
      throw new HttpError(403, "Запуск доступен только водителю.");
    const body = z.object({ bookingId: z.uuid() }).strict().parse(req.body),
      key = idempotencyKey.parse(req.get("Idempotency-Key"));
    const session = await startSession(
      pool,
      req.identity!.id,
      body.bookingId,
      key,
    );
    res.status(session.status === "starting" ? 202 : 200).json(session);
  });
  router.get("/:id", async (req, res) =>
    res.json(
      await getSession(pool, z.uuid().parse(req.params.id), req.identity!),
    ),
  );
  router.post("/:id/stop", async (req, res) => {
    if (req.identity!.role !== "driver")
      throw new HttpError(403, "Остановка доступна только владельцу.");
    emptyBody.parse(req.body ?? {});
    const key = idempotencyKey.parse(req.get("Idempotency-Key"));
    const s = await stopSession(
      pool,
      req.identity!.id,
      z.uuid().parse(req.params.id),
      key,
    );
    res.status(s.status === "stopping" ? 202 : 200).json(s);
  });
  return router;
}
