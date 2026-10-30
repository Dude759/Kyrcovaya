import { Router } from "express";
import { z } from "zod";
import type { Database } from "../../db/pool.js";
import { transaction } from "../../db/pool.js";
import { operatorOnly } from "../auth/middleware.js";
import { HttpError } from "../../middleware/errors.js";
import {
  historyDto,
  monitoredSelect,
  monitoredSession,
  monitoringSnapshot,
  ownStation,
} from "./monitoring.js";
const time = z.string().datetime({ offset: true });
const cursor = z
  .string()
  .max(600)
  .transform((v, ctx) => {
    try {
      return z
        .tuple([time, z.string().min(1).max(100)])
        .parse(JSON.parse(Buffer.from(v, "base64url").toString()));
    } catch {
      ctx.addIssue({ code: "custom", message: "Некорректный курсор" });
      return z.NEVER;
    }
  });
const filters = z
  .object({
    stationId: z.string().min(1).max(80).optional(),
    from: time.optional(),
    to: time.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: cursor.optional(),
  })
  .strict();
function page(rows: any[], limit: number, tuple: (r: any) => any[]) {
  return {
    items: rows.slice(0, limit),
    nextCursor:
      rows.length > limit
        ? Buffer.from(JSON.stringify(tuple(rows[limit - 1]))).toString(
            "base64url",
          )
        : null,
  };
}
function range(v: { from?: string; to?: string }) {
  const to = new Date(v.to ?? Date.now()),
    from = new Date(v.from ?? to.getTime() - 86400000);
  if (
    from >= to ||
    to.getTime() - from.getTime() > 31 * 86400000 ||
    to.getTime() > Date.now() + 3600000
  )
    throw new HttpError(400, "История: до 31 дня, без будущего прогноза.");
  return { from, to };
}
export function monitoringRoutes(pool: Database) {
  const router = Router();
  router.use(operatorOnly);
  const read = (work: (db: any) => Promise<any>) =>
    transaction(pool, async (db) => {
      await db.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      return work(db);
    });
  router.get("/monitoring", async (req, res) => {
    z.object({}).strict().parse(req.query);
    res.json(
      await read((db) => monitoringSnapshot(db, req.identity!.organizationId!)),
    );
  });
  router.get("/monitoring/stations/:id", async (req, res) => {
    z.object({}).strict().parse(req.query);
    res.json(
      await read(async (db) => {
        const org = req.identity!.organizationId!,
          id = String(req.params.id),
          snapshot = await monitoringSnapshot(db, org, id);
        const ports = (
          await db.query(
            `SELECT c.id,c.label,c.type,c.max_power_kw,c.operating_state,c.archived_at,d.online AS simulator_online FROM connectors c LEFT JOIN simulator_devices d ON d.connector_id=c.id WHERE c.station_id=$1 ORDER BY c.id LIMIT 200`,
            [id],
          )
        ).rows.map((c: any) => ({
          id: c.id,
          label: c.label,
          type: c.type,
          maxPowerKw: Number(c.max_power_kw),
          status: c.operating_state,
          archivedAt: c.archived_at,
          simulatorOnline: c.simulator_online ?? null,
        }));
        return { ...snapshot, ports };
      }),
    );
  });
  router.get("/monitoring/history", async (req, res) => {
    const v = filters
        .extend({
          quality: z.enum(["complete", "partial", "missing"]).optional(),
        })
        .parse(req.query),
      { from, to } = range(v);
    res.json(
      await read(async (db) => {
        const org = req.identity!.organizationId!;
        if (v.stationId) await ownStation(db, org, v.stationId);
        const rows = (
          await db.query(
            `SELECT h.*,s.name AS station_name FROM power_measurements h JOIN stations s ON s.id=h.station_id WHERE h.organization_id=$1 AND ($2::text IS NULL OR h.station_id=$2) AND h.interval_start>=$3 AND h.interval_start<$4 AND ($5::text IS NULL OR h.quality=$5) AND ($6::timestamptz IS NULL OR (h.interval_start,h.station_id)<($6::timestamptz,$7::text)) ORDER BY h.interval_start DESC,h.station_id DESC LIMIT $8`,
            [
              org,
              v.stationId ?? null,
              from,
              to,
              v.quality ?? null,
              v.cursor?.[0] ?? null,
              v.cursor?.[1] ?? null,
              v.limit + 1,
            ],
          )
        ).rows;
        const result = page(rows, v.limit, (r: any) => [
          r.interval_start.toISOString(),
          r.station_id,
        ]);
        return {
          ...result,
          items: result.items.map(historyDto),
          source: "simulator",
          gridBudgetKw: null,
        };
      }),
    );
  });
  router.get("/sessions", async (req, res) => {
    const v = filters
      .extend({
        status: z
          .enum(["starting", "active", "stopping", "completed", "failed"])
          .optional(),
      })
      .parse(req.query);
    if (v.from || v.to) range(v);
    res.json(
      await read(async (db) => {
        const org = req.identity!.organizationId!;
        if (v.stationId) await ownStation(db, org, v.stationId);
        const now = (await db.query("SELECT clock_timestamp() AS now")).rows[0]
          .now;
        const rows = (
          await db.query(
            monitoredSelect +
              ` WHERE s.organization_id=$1 AND ($2::text IS NULL OR s.station_id=$2) AND ($3::text IS NULL OR s.status=$3) AND ($4::timestamptz IS NULL OR s.requested_at>=$4) AND ($5::timestamptz IS NULL OR s.requested_at<$5) AND ($6::timestamptz IS NULL OR (s.requested_at,s.id)<($6::timestamptz,$7::uuid)) ORDER BY s.requested_at DESC,s.id DESC LIMIT $8`,
            [
              org,
              v.stationId ?? null,
              v.status ?? null,
              v.from ?? null,
              v.to ?? null,
              v.cursor?.[0] ?? null,
              v.cursor ? z.uuid().parse(v.cursor[1]) : null,
              v.limit + 1,
            ],
          )
        ).rows;
        const result = page(rows, v.limit, (r: any) => [
          r.requested_at.toISOString(),
          r.id,
        ]);
        return {
          ...result,
          items: result.items.map((r: any) => monitoredSession(r, now)),
          asOf: now.toISOString(),
          source: "simulator",
        };
      }),
    );
  });
  router.get("/monitoring/events", async (req, res) => {
    const v = filters.parse(req.query);
    if (v.from || v.to) range(v);
    res.json(
      await read(async (db) => {
        const org = req.identity!.organizationId!;
        if (v.stationId) await ownStation(db, org, v.stationId);
        const rows = (
          await db.query(
            `SELECT * FROM (
        SELECT 'command:'||c.id AS id,s.station_id,c.session_id,COALESCE(c.confirmed_at,c.created_at) AS at,c.kind AS kind,c.status AS status FROM charging_commands c JOIN charging_sessions s ON s.id=c.session_id WHERE s.organization_id=$1
        UNION ALL SELECT 'gap:'||m.id,s.station_id,m.session_id,m.sampled_at,'measurement_gap','observed' FROM session_measurements m JOIN charging_sessions s ON s.id=m.session_id WHERE s.organization_id=$1 AND m.gap
        )e WHERE ($2::text IS NULL OR station_id=$2) AND ($3::timestamptz IS NULL OR at>=$3) AND ($4::timestamptz IS NULL OR at<$4) AND ($5::timestamptz IS NULL OR (at,id)<($5::timestamptz,$6::text)) ORDER BY at DESC,id DESC LIMIT $7`,
            [
              org,
              v.stationId ?? null,
              v.from ?? null,
              v.to ?? null,
              v.cursor?.[0] ?? null,
              v.cursor?.[1] ?? null,
              v.limit + 1,
            ],
          )
        ).rows;
        const result = page(rows, v.limit, (r: any) => [
          r.at.toISOString(),
          r.id,
        ]);
        return {
          ...result,
          source: "simulator",
          items: result.items.map((r: any) => ({
            id: r.id,
            stationId: r.station_id,
            sessionId: r.session_id,
            at: r.at.toISOString(),
            kind: r.kind,
            status: r.status,
          })),
        };
      }),
    );
  });
  return router;
}
