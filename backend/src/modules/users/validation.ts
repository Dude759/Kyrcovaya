import { z } from "zod";
export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z.string().min(8).max(128);
export const connectorType = z.enum(["CCS2", "CHAdeMO", "Type 2"]);
export const personalFields = {
  name: z.string().trim().min(2).max(100),
  email,
  phone: z.string().trim().max(32),
};
export const driverFields = {
  vehicle: z.string().trim().max(100),
  plate: z.string().trim().max(20),
  connector: connectorType,
  battery: z.number().finite().min(10).max(250),
};
export const driverProfile = z
  .object({ ...personalFields, ...driverFields })
  .strict();
export const operatorProfile = z.object(personalFields).strict();
export const registration = driverProfile.extend({
  password,
  role: z.literal("driver").optional(),
});
export const login = z
  .object({
    email,
    password: z.string().min(1).max(128),
    role: z.enum(["driver", "operator"]),
  })
  .strict();
export const preferences = z
  .object({
    bookingAlerts: z.boolean().optional(),
    receipts: z.boolean().optional(),
    networkAlerts: z.boolean().optional(),
    criticalAlerts: z.boolean().optional(),
    loadAlerts: z.boolean().optional(),
    reports: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
