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
  const origins = value.CORS_ORIGINS.split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (origins.some((v) => !/^https?:\/\/[^/]+$/.test(v)))
    throw new Error("CORS_ORIGINS must contain exact HTTP(S) origins");
  return { ...value, origins };
}
export type Config = ReturnType<typeof loadConfig>;
