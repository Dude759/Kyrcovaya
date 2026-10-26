import express from "express";
import cors from "cors";
import helmet from "helmet";
import type { Config } from "./config/env.js";
import type { Database } from "./db/pool.js";
import { errorHandler, HttpError } from "./middleware/errors.js";
import { authRoutes } from "./modules/auth/routes.js";
import { authenticate, operatorOnly } from "./modules/auth/middleware.js";
import { userRoutes } from "./modules/users/routes.js";
import { catalogRoutes } from "./modules/catalog/routes.js";
import { workspaceRoutes } from "./modules/workspace/routes.js";

export function createApp(
  pool: Database,
  config: Pick<Config, "origins" | "AUTH_TTL_SECONDS">,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(
    cors({
      origin(origin, done) {
        if (!origin || config.origins.includes(origin)) done(null, true);
        else done(new HttpError(403, "Источник запроса не разрешён."));
      },
      methods: ["GET", "POST", "PATCH", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );
  app.use(express.json({ limit: "16kb" }));
  app.get(["/health", "/api/health"], (_req, res) => {
    res.json({ status: "ok", version: "0.1.0" });
  });
  app.get(["/ready", "/api/ready"], async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ready" });
    } catch {
      res.status(503).json({ message: "База данных недоступна." });
    }
  });
  app.use("/api/auth", authRoutes(pool, config.AUTH_TTL_SECONDS));
  app.use("/api/stations", catalogRoutes(pool));
  const unavailable = () => {
    throw new HttpError(
      501,
      "Функция ещё не подключена к серверу. В этой версии доступны профиль, настройки и каталог станций.",
    );
  };
  app.post(["/api/auth/recovery", "/api/auth/reset"], unavailable);
  app.use("/api", authenticate(pool), userRoutes(pool), workspaceRoutes(pool));
  app.use("/api/operator", operatorOnly, unavailable);
  for (const path of [
    "/api/bookings",
    "/api/payments",
    "/api/sessions",
    "/api/auth/password",
    "/api/auth/recovery",
    "/api/auth/reset",
  ])
    app.use(path, unavailable);
  app.use((_req, _res, next) => next(new HttpError(404, "Маршрут не найден.")));
  app.use(errorHandler);
  return app;
}
