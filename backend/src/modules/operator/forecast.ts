import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Database } from "../../db/pool.js";
import { transaction } from "../../db/pool.js";
import { operatorOnly } from "../auth/middleware.js";
import { HttpError } from "../../middleware/errors.js";
import {
  TRUSTED_BUNDLE_HASH,
  TRUSTED_MODEL_VERSION,
  DATASET_HASH,
} from "./forecast-trust.js";
const number = z.number().finite().min(0);
const point = z
  .object({
    h: z.number().int().min(1).max(24),
    time: z.iso.datetime(),
    powerKw: number,
    lastKw: number.nullable(),
    weeklyKw: number.nullable(),
  })
  .strict();
const schema = z
  .object({
    organizationId: z.uuid(),
    source: z.literal("synthetic"),
    mode: z.literal("historical_replay"),
    origin: z.iso.datetime(),
    generatedAt: z.iso.datetime(),
    modelVersion: z.string(),
    quality: z.literal("synthetic_experiment_only"),
    datasetHash: z.string(),
    metrics: z.object({ validation: z.any(), test: z.any() }),
    points: z.array(point).length(24),
  })
  .strict();
export function verifyForecastBundle(text: string) {
  const canonical = text.replaceAll("\r\n", "\n").trim();
  if (
    createHash("sha256").update(canonical).digest("hex") !== TRUSTED_BUNDLE_HASH
  )
    throw new Error("Untrusted forecast bundle checksum");
  const data = schema.parse(JSON.parse(canonical));
  if (
    data.modelVersion !== TRUSTED_MODEL_VERSION ||
    data.datasetHash !== DATASET_HASH
  )
    throw new Error("Incompatible dataset or modelVersion");
  if (
    data.points.some(
      (p, i) =>
        p.h !== i + 1 ||
        Date.parse(p.time) !== Date.parse(data.origin) + (i + 1) * 3600000,
    )
  )
    throw new Error("Invalid forecast horizon");
  return data;
}
export const readForecastBundle = async () =>
  verifyForecastBundle(await readFile("assets/demo-forecast.json", "utf8"));
export async function seedForecast(pool: Database) {
  const bundle = await readForecastBundle();
  await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(7241033)");
    const old = (
      await db.query(
        "SELECT * FROM forecast_runs WHERE organization_id=$1 AND model_version=$2 AND origin=$3",
        [bundle.organizationId, bundle.modelVersion, bundle.origin],
      )
    ).rows[0];
    if (old) {
      if (old.artifact_checksum !== TRUSTED_BUNDLE_HASH)
        throw new Error("Immutable forecast conflicts with artifact");
      return;
    }
    const { points, ...metadata } = bundle;
    const r = (
      await db.query(
        `INSERT INTO forecast_runs(organization_id,model_version,source,mode,origin,generated_at,quality,artifact_checksum,dataset_hash,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          bundle.organizationId,
          bundle.modelVersion,
          bundle.source,
          bundle.mode,
          bundle.origin,
          bundle.generatedAt,
          bundle.quality,
          TRUSTED_BUNDLE_HASH,
          DATASET_HASH,
          JSON.stringify(metadata),
        ],
      )
    ).rows[0];
    for (const p of points)
      await db.query(
        "INSERT INTO load_predictions(run_id,organization_id,horizon,target_at,power_kw,last_kw,weekly_kw) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          r.id,
          bundle.organizationId,
          p.h,
          p.time,
          p.powerKw,
          p.lastKw,
          p.weeklyKw,
        ],
      );
  });
}
export function forecastRoutes(pool: Database) {
  const router = Router();
  router.use(operatorOnly);
  router.get("/forecast", async (req, res) => {
    z.object({}).strict().parse(req.query);
    const result = (
      await pool.query(
        `SELECT count(*) FILTER(WHERE quality='complete')::int AS complete,count(*)::int AS hours FROM power_measurements WHERE organization_id=$1 AND interval_end<=clock_timestamp()`,
        [req.identity!.organizationId],
      )
    ).rows[0];
    res.json({
      status: "insufficient_data",
      readiness: "NEEDS_MORE_DATA",
      source: "actual",
      forecast: null,
      reason:
        "Полной истории рабочей сети недостаточно; модель обучена только на synthetic. Качество на реальной сети не подтверждено.",
      quality: {
        completeStationHours: result.complete,
        stationHours: result.hours,
      },
      asOf: new Date().toISOString(),
      mode: "offline_only",
    });
  });
  router.get("/forecast/demo", async (req, res) => {
    z.object({}).strict().parse(req.query);
    const bundle = await readForecastBundle().catch(() => {
      throw new HttpError(503, "Доверенный артефакт прогноза недоступен.");
    });
    if (req.identity!.organizationId !== bundle.organizationId)
      throw new HttpError(404, "Учебный эксперимент организации не найден.");
    const r = (
      await pool.query(
        `SELECT * FROM forecast_runs WHERE organization_id=$1 AND model_version=$2 AND origin=$3`,
        [req.identity!.organizationId, bundle.modelVersion, bundle.origin],
      )
    ).rows[0];
    if (!r)
      throw new HttpError(
        503,
        "Версионированный учебный эксперимент ещё не опубликован.",
      );
    if (r.artifact_checksum !== TRUSTED_BUNDLE_HASH)
      throw new HttpError(
        503,
        "Версия сохранённого прогноза не соответствует артефакту.",
      );
    const rows = (
      await pool.query(
        "SELECT * FROM load_predictions WHERE run_id=$1 AND organization_id=$2 ORDER BY horizon",
        [r.id, req.identity!.organizationId],
      )
    ).rows;
    const points = rows.map((p) => ({
      h: p.horizon,
      time: p.target_at.toISOString().replace(".000Z", "Z"),
      powerKw: Number(p.power_kw),
      lastKw: p.last_kw === null ? null : Number(p.last_kw),
      weeklyKw: p.weekly_kw === null ? null : Number(p.weekly_kw),
    }));
    if (
      points.length !== 24 ||
      points.some((p, i) =>
        Object.entries(p).some(
          ([k, v]) => v !== bundle.points[i][k as keyof typeof p],
        ),
      )
    )
      throw new HttpError(
        503,
        "Сохранённые точки не прошли проверку артефакта.",
      );
    res.json({
      status: "ready",
      historical: true,
      staleForCurrentNetwork: true,
      forecast: { ...bundle, points },
      warning:
        "Исторический synthetic эксперимент RandomForest. Это не прогноз на сегодня и не подтверждение качества на реальной сети.",
    });
  });
  router.post("/forecast", (_req, res) => {
    res
      .status(501)
      .json({
        message:
          "Offline replay: новый прогноз вычисляется Python pipeline и публикуется версионированным артефактом. Динамический inference не подключён.",
      });
  });
  return router;
}
