import { Router } from "express";
import { z } from "zod";
import type { Database } from "../../db/pool.js";
import { HttpError } from "../../middleware/errors.js";
import { emptyBody } from "../payments/validation.js";
import { cancelBooking } from "./service.js";
export function bookingRoutes(pool: Database) {
  const router = Router();
  router.post("/:id/cancel", async (req, res) => {
    if (req.identity!.role !== "driver")
      throw new HttpError(403, "Отмена доступна только владельцу-водителю.");
    emptyBody.parse(req.body ?? {});
    res.json(
      await cancelBooking(
        pool,
        req.identity!.id,
        z.uuid().parse(req.params.id),
      ),
    );
  });
  return router;
}
