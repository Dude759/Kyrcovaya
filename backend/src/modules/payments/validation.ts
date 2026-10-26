import { z } from "zod";
import { instant } from "../reservations/validation.js";
import { connectorType } from "../users/validation.js";

export const idempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_.:~-]+$/);
export const paymentInput = z
  .object({
    input: z
      .object({
        stationId: z.string().min(1).max(80),
        connector: connectorType,
        start: instant,
        duration: z.union([
          z.literal(30),
          z.literal(45),
          z.literal(60),
          z.literal(90),
        ]),
        payment: z.enum(["card", "sbp"]),
      })
      .strict(),
  })
  .strict();
export const emptyBody = z.object({}).strict();
export const providerEvent = z
  .object({
    providerEventId: z.string().min(1).max(160),
    providerPaymentId: z.uuid(),
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
    amountKopecks: z.number().int().min(0).max(100000000000),
    currency: z.literal("RUB"),
  })
  .strict();
export type TestEvent = z.infer<typeof providerEvent>;
