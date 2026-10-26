import { z } from "zod";
import { connectorType } from "../users/validation.js";
import { HttpError } from "../../middleware/errors.js";

export const instant = z.iso.datetime({ offset: true });
export const availabilityInput = z
  .object({
    start: instant,
    duration: z.enum(["30", "45", "60", "90"]).transform(Number),
    connector: connectorType,
  })
  .strict();

export const holdInput = z
  .object({
    // Trusted server scope, never accepted from a public write endpoint.
    organizationId: z.uuid(),
    stationId: z.string().min(1).max(80),
    connector: connectorType,
    connectorId: z.uuid().optional(),
    startAt: instant,
    endAt: instant,
    ttlSeconds: z.number().int().min(1).max(900).default(900),
  })
  .strict();

export function validateInterval(start: Date, end: Date, now: Date) {
  const duration = end.getTime() - start.getTime();
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 90 * 60000 ||
    start.getTime() <= now.getTime() ||
    start.getTime() > now.getTime() + 4 * 86400000
  )
    throw new HttpError(
      400,
      "Проверьте будущий интервал: не более 90 минут и четырёх суток до начала.",
    );
}
