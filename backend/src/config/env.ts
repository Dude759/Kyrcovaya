import { existsSync } from "node:fs";
import { z } from "zod";

if (existsSync(".env")) process.loadEnvFile(".env");

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  DATABASE_URL: z
    .string()
    .url()
    .refine((v) => /^postgres(ql)?:/.test(v)),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://127.0.0.1:5173"),
  DATABASE_URL_UNPOOLED: z.string().url().optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(1).default(0),
  PUBLIC_DEMO: z.enum(["true", "false"]).default("false"),
  DEPLOY_SEED: z.enum(["true", "false"]).default("false"),
  PAYMENT_PUBLIC_ORIGIN: z
    .string()
    .url()
    .refine((v) => {
      const url = new URL(v);
      return (
        url.protocol === "https:" &&
        url.pathname === "/" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    })
    .transform((v) => new URL(v).origin)
    .optional(),
  PAYMENT_WEBHOOK_SECRET: z.string().min(32).max(256).optional(),
  AUTH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(2592000)
    .default(604800),
});

export function loadConfig() {
  const result = schema.safeParse(process.env);
  if (!result.success)
    throw new Error(
      `Invalid environment fields: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const value = result.data;
  if (
    Boolean(value.PAYMENT_PUBLIC_ORIGIN) !==
    Boolean(value.PAYMENT_WEBHOOK_SECRET)
  )
    throw new Error("Set both payment provider environment fields");
  if (value.NODE_ENV === "production") {
    if (!process.env.CORS_ORIGINS)
      throw new Error("CORS_ORIGINS must be explicit in production");
    for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"] as const) {
      if (!value[key]) continue;
      const url = new URL(value[key]);
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        url.searchParams.get("sslmode") !== "verify-full"
      ) {
        throw new Error(`${key} must use sslmode=verify-full in production`);
      }
    }
  }
  const origins = value.CORS_ORIGINS.split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (origins.some((v) => !/^https?:\/\/[^/]+$/.test(v)))
    throw new Error("CORS_ORIGINS must contain exact HTTP(S) origins");
  return { ...value, origins };
}
export type Config = ReturnType<typeof loadConfig>;
