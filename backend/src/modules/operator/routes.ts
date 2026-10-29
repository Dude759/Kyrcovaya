import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Database } from "../../db/pool.js";
import { chargingWork } from "../sessions/graph.js";
import { HttpError } from "../../middleware/errors.js";
import { hash } from "../payments/provider.js";
import { idempotencyKey, emptyBody } from "../payments/validation.js";
import { connectorType } from "../users/validation.js";

const power = z.number().finite().positive().max(1000000).multipleOf(0.01);
const stationShape = z
  .object({
    name: z.string().trim().min(2).max(160),
    address: z.string().trim().min(2).max(300),
    district: z.string().trim().max(120),
    coordinates: z.tuple([
      z.number().finite().min(-180).max(180),
      z.number().finite().min(-90).max(90),
    ]),
    maxPowerKw: power,
    limitKw: z.number().finite().min(0).max(1000000).multipleOf(0.01),
    pricePerKwh: z.number().finite().min(0).max(10000).multipleOf(0.01),
    status: z.enum(["online", "offline", "service"]),
  })
  .strict();
const portShape = z
  .object({
    label: z.string().trim().min(1).max(60),
    type: connectorType,
    maxPowerKw: power,
    status: z.enum(["idle", "offline", "service"]),
  })
  .strict();
const stationCreate = stationShape
  .omit({ status: true })
  .extend({ district: z.string().trim().max(120).default("") });
const nonempty = (v: object) => Object.keys(v).length > 0;
const stationPatch = stationShape.partial().refine(nonempty),
  portPatch = portShape.partial().refine(nonempty);
const stationDto = (s: any) => ({
  id: s.id,
  name: s.name,
  address: s.address,
  district: s.district,
  coordinates: [Number(s.longitude), Number(s.latitude)],
  maxPowerKw: Number(s.max_power_kw),
  limitKw: Number(s.limit_kw),
  pricePerKwh: s.price_per_kwh_kopecks / 100,
  status: s.operating_state,
  archivedAt: s.archived_at,
  teaching: true,
});
const portDto = (c: any) => ({
  id: c.id,
  stationId: c.station_id,
  label: c.label,
  type: c.type,
  maxPowerKw: Number(c.max_power_kw),
  status: c.operating_state,
  archivedAt: c.archived_at,
});
export async function listEvents(
  db: any,
  org: string,
  limit = 30,
  cursor?: string,
) {
  const rows = (
    await db.query(
    `SELECT id::text,actor_id AS "actorId",station_id AS "stationId",connector_id AS "connectorId",action,before_data AS before,after_data AS after,created_at AS date FROM network_events WHERE organization_id=$1 AND ($2::bigint IS NULL OR id<$2::bigint) ORDER BY network_events.id DESC LIMIT $3`,
      [org, cursor ?? null, limit + 1],
    )
  ).rows;
  return {
    items: rows
      .slice(0, limit)
      .map((r: any) => ({ ...r, message: r.action, severity: "info" })),
    nextCursor: rows.length > limit ? rows[limit - 1].id : null,
  };
}
export function operatorRoutes(pool: Database) {
  const router = Router();
  router.use((req, _res, next) => {
    if (req.identity!.role !== "operator")
      throw new HttpError(403, "Требуется оператор организации.");
    next();
  });
  router.get("/events", async (req, res) => {
    const v = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(30),
        cursor: z
          .string()
          .regex(/^[1-9][0-9]{0,18}$/)
          .optional(),
      })
      .strict()
      .parse(req.query);
    res.json(
      await listEvents(pool, req.identity!.organizationId!, v.limit, v.cursor),
    );
  });
  router.get("/stations", async (req, res) => {
    res.json({
      items: (
        await pool.query(
          "SELECT * FROM stations WHERE organization_id=$1 ORDER BY created_at,id",
          [req.identity!.organizationId],
        )
      ).rows.map(stationDto),
    });
  });
  router.get("/stations/:id/connectors", async (req, res) => {
    const s = (
      await pool.query(
        "SELECT id FROM stations WHERE id=$1 AND organization_id=$2",
        [req.params.id, req.identity!.organizationId],
      )
    ).rows[0];
    if (!s) throw new HttpError(404, "Станция не найдена.");
    res.json({
      items: (
        await pool.query(
          "SELECT * FROM connectors WHERE station_id=$1 ORDER BY label",
          [s.id],
        )
      ).rows.map(portDto),
    });
  });
  async function change(
    req: any,
    kind: "station" | "connector",
    create: boolean,
    archive = false,
  ) {
    const org = req.identity.organizationId;
    const body = archive
      ? emptyBody.parse(req.body ?? {})
      : create
        ? (kind === "station" ? stationCreate : portShape).parse(req.body)
        : (kind === "station" ? stationPatch : portPatch).parse(req.body);
    const key = create
      ? idempotencyKey.parse(req.get("Idempotency-Key"))
      : null;
    const signature = hash(
      JSON.stringify({
        kind,
        parent: create && kind === "connector" ? req.params.id : null,
        body,
      }),
    );
    try {
      return await chargingWork(pool, async (db) => {
        if (key) {
          await db.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`operator:${org}:${key}`],
          );
          const prev = (
            await db.query(
              "SELECT * FROM operator_requests WHERE organization_id=$1 AND idempotency_key=$2",
              [org, key],
            )
          ).rows[0];
          if (prev) {
            if (prev.request_hash !== signature)
              throw new HttpError(409, "Ключ использован для другого запроса.");
            return prev.result;
          }
        }
        await db.query("SET LOCAL app.operator_management='on'");
        let s: any, c: any, before: any, result: any;
        if (create && kind === "station") {
          const v = body as any;
          if (v.limitKw > v.maxPowerKw)
            throw new HttpError(400, "Лимит превышает мощность станции.");
          s = (
            await db.query(
              `INSERT INTO stations(id,organization_id,name,address,district,longitude,latitude,max_power_kw,limit_kw,price_per_kwh_kopecks,operating_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'service') RETURNING *`,
              [
                "teaching-" + randomUUID(),
                org,
                v.name,
                v.address,
                v.district,
                ...v.coordinates,
                v.maxPowerKw,
                v.limitKw,
                Math.round(v.pricePerKwh * 100),
              ],
            )
          ).rows[0];
          result = stationDto(s);
        } else {
          let sid = req.params.id;
          if (kind === "connector" && !create) {
            const found = (
              await db.query(
                "SELECT c.station_id FROM connectors c JOIN stations s ON s.id=c.station_id WHERE c.id=$1 AND s.organization_id=$2",
                [z.uuid().parse(req.params.id), org],
              )
            ).rows[0];
            if (!found) throw new HttpError(404, "Порт не найден.");
            sid = found.station_id;
          }
          s = (
            await db.query(
              "SELECT * FROM stations WHERE id=$1 AND organization_id=$2 FOR UPDATE",
              [sid, org],
            )
          ).rows[0];
          if (!s) throw new HttpError(404, "Станция не найдена.");
          const ports = (
            await db.query(
              "SELECT * FROM connectors WHERE station_id=$1 ORDER BY id FOR UPDATE",
              [s.id],
            )
          ).rows;
          if (s.archived_at && !(archive && kind === "station"))
            throw new HttpError(409, "Станция архивирована.");
          if (kind === "station") {
            before = stationDto(s);
            if (archive && s.archived_at) return before;
            const v = { ...before, ...body };
            if (
              v.limitKw > v.maxPowerKw ||
              ports.some(
                (p: any) =>
                  !p.archived_at && Number(p.max_power_kw) > v.maxPowerKw,
              )
            )
              throw new HttpError(
                409,
                "Мощность несовместима с лимитом или портами.",
              );
            if (
              v.status === "online" &&
              !ports.some(
                (p: any) => !p.archived_at && p.operating_state === "idle",
              )
            )
              throw new HttpError(
                409,
                "Добавьте доступный физический порт перед активацией.",
              );
            s = (
              await db.query(
                `UPDATE stations SET name=$2,address=$3,district=$4,longitude=$5,latitude=$6,max_power_kw=$7,limit_kw=$8,price_per_kwh_kopecks=$9,operating_state=$10,archived_at=CASE WHEN $11 THEN clock_timestamp() ELSE archived_at END WHERE id=$1 RETURNING *`,
                [
                  s.id,
                  v.name,
                  v.address,
                  v.district,
                  ...v.coordinates,
                  v.maxPowerKw,
                  v.limitKw,
                  Math.round(v.pricePerKwh * 100),
                  v.status,
                  archive,
                ],
              )
            ).rows[0];
            result = stationDto(s);
          } else {
            c = create ? null : ports.find((p: any) => p.id === req.params.id);
            if (!create && !c) throw new HttpError(404, "Порт не найден.");
            before = c ? portDto(c) : null;
            if (c?.archived_at) {
              if (archive) return before;
              throw new HttpError(409, "Порт архивирован.");
            }
            const v = { ...before, ...body };
            if (v.maxPowerKw > Number(s.max_power_kw))
              throw new HttpError(409, "Порт мощнее станции.");
            if (
              c &&
              v.type !== c.type &&
              (
                await db.query(
                  "SELECT 1 FROM payments WHERE connector_id=$1 LIMIT 1",
                  [c.id],
                )
              ).rowCount
            )
              throw new HttpError(409, "Тип порта с историей неизменяем.");
            c = create
              ? (
                  await db.query(
                    "INSERT INTO connectors(station_id,label,type,max_power_kw,operating_state) VALUES($1,$2,$3,$4,$5) RETURNING *",
                    [s.id, v.label, v.type, v.maxPowerKw, v.status],
                  )
                ).rows[0]
              : (
                  await db.query(
                    `UPDATE connectors SET label=$2,type=$3,max_power_kw=$4,operating_state=$5,archived_at=CASE WHEN $6 THEN clock_timestamp() ELSE archived_at END WHERE id=$1 RETURNING *`,
                    [c.id, v.label, v.type, v.maxPowerKw, v.status, archive],
                  )
                ).rows[0];
            result = portDto(c);
          }
        }
        await db.query(
          "INSERT INTO network_events(organization_id,actor_id,station_id,connector_id,action,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            org,
            req.identity.id,
            s.id,
            c?.id ?? null,
            `${kind}_${create ? "created" : archive ? "archived" : "updated"}`,
            before ?? null,
            result,
          ],
        );
        if (key)
          await db.query("INSERT INTO operator_requests VALUES($1,$2,$3,$4)", [
            org,
            key,
            signature,
            result,
          ]);
        return result;
      });
    } catch (e) {
      if (["23514", "23503"].includes((e as any).code))
        throw new HttpError(
          409,
          "Изменение нарушает резерв, историю или локальный лимит мощности.",
        );
      throw e;
    }
  }
  router.post("/stations", async (req, res) =>
    res.status(201).json(await change(req, "station", true)),
  );
  router.patch("/stations/:id", async (req, res) =>
    res.json(await change(req, "station", false)),
  );
  router.post("/stations/:id/connectors", async (req, res) =>
    res.status(201).json(await change(req, "connector", true)),
  );
  router.patch("/connectors/:id", async (req, res) =>
    res.json(await change(req, "connector", false)),
  );
  router.post("/stations/:id/archive", async (req, res) =>
    res.json(await change(req, "station", false, true)),
  );
  router.post("/connectors/:id/archive", async (req, res) =>
    res.json(await change(req, "connector", false, true)),
  );
  return router;
}
