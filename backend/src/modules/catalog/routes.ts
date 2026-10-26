import { Router } from "express";
import type { Database } from "../../db/pool.js";
import { authenticate } from "../auth/middleware.js";
import { listStations, stationDetail, physicalConnectors } from "./service.js";

export function catalogRoutes(pool: Database) {
  const router = Router();
  // The public landing page can read the public catalog. A supplied token is always validated.
  router.use((req, res, next) =>
    req.headers.authorization ? authenticate(pool)(req, res, next) : next(),
  );
  router.get("/", async (req, res) => {
    res.json(await listStations(pool, req.identity, req.query));
  });
  router.get("/:id/connectors", async (req, res) => {
    res.json(
      await physicalConnectors(pool, req.identity, String(req.params.id)),
    );
  });
  router.get("/:id", async (req, res) => {
    res.json(await stationDetail(pool, req.identity, String(req.params.id)));
  });
  return router;
}
