import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { transaction, type Database } from "../../db/pool.js";
import { HttpError } from "../../middleware/errors.js";
import {
  createHoldInTransaction,
  releaseHoldInTransaction,
  databaseNow,
} from "../reservations/service.js";
import { validateInterval } from "../reservations/validation.js";
import { quote } from "../reservations/quote.js";
import { idempotencyKey, paymentInput, providerEvent } from "./validation.js";
import {
  confirmationUrl,
  hash,
  verifyEvent,
  type PaymentOptions,
} from "./provider.js";

type Row = Record<string, any>;
async function work<T>(
  pool: Database,
  callback: (db: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++)
    try {
      return await transaction(pool, callback);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23P01")
        throw new HttpError(409, "Порт уже удерживается другим заказом.");
      if (!["40P01", "40001"].includes(code ?? "")) throw error;
      if (attempt === 2)
        throw new HttpError(
          409,
          "Конкурентное изменение. Повторите запрос с тем же ключом.",
        );
    }
}
async function lockOrder(
  db: PoolClient,
  id: string,
  userId?: string,
): Promise<Row> {
  const row = (
    await db.query(
      "SELECT * FROM payments WHERE id=$1 AND ($2::uuid IS NULL OR user_id=$2) FOR UPDATE",
      [id, userId ?? null],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "Платёж не найден.");
  return row;
}
async function reservation(db: PoolClient, id: string): Promise<Row> {
  const row = (
    await db.query("SELECT * FROM connector_reservations WHERE payment_id=$1", [
      id,
    ])
  ).rows[0];
  if (!row) throw new Error("Payment hold missing");
  return row;
}
async function latest(db: PoolClient, id: string): Promise<Row> {
  const row = (
    await db.query(
      "SELECT * FROM payment_attempts WHERE payment_id=$1 ORDER BY attempt_no DESC LIMIT 1",
      [id],
    )
  ).rows[0];
  if (!row) throw new Error("Payment attempt missing");
  return row;
}
async function expire(db: PoolClient, p: Row): Promise<Row> {
  if (p.status !== "pending" || p.expires_at > (await databaseNow(db)))
    return p;
  const r = await reservation(db, p.id);
  await releaseHoldInTransaction(db, p.organization_id, r.id);
  await db.query(
    "UPDATE payment_attempts SET status='expired',resolved_at=clock_timestamp() WHERE payment_id=$1 AND status='pending'",
    [p.id],
  );
  return (
    await db.query(
      `UPDATE payments SET status='failed',failure_code='expired',
    requires_reconciliation=requires_reconciliation OR provider_success_received_at IS NOT NULL WHERE id=$1 RETURNING *`,
      [p.id],
    )
  ).rows[0];
}
async function dto(db: PoolClient, p: Row, options: PaymentOptions) {
  const a = await latest(db, p.id),
    r = await reservation(db, p.id);
  const providerSuccess = Boolean(p.provider_success_received_at);
  return {
    id: p.id,
    userId: p.user_id,
    input: {
      stationId: p.station_id,
      connector: p.requested_connector_type,
      start: p.start_at.toISOString(),
      duration: (p.end_at - p.start_at) / 60000,
      payment: p.method,
    },
    amount: Number(p.amount_kopecks) / 100,
    amountKopecks: Number(p.amount_kopecks),
    tariffKopecks: p.quoted_tariff_kopecks,
    estimatedEnergyKwh: Number(p.quoted_energy_kwh),
    status: p.status,
    bookingId: null,
    createdAt: p.created_at.toISOString(),
    expiresAt: p.expires_at.toISOString(),
    failure:
      p.failure_code === "expired"
        ? "Время тестовой оплаты истекло."
        : p.failure_code === "provider_failed"
          ? "Тестовый провайдер отклонил попытку."
          : p.failure_code === "cancelled"
            ? "Тестовая оплата отменена."
            : null,
    test: true,
    providerSuccessReceived: providerSuccess,
    awaitingFinalization:
      providerSuccess && p.status === "pending" && !p.requires_reconciliation,
    reconciliationRequired: p.requires_reconciliation,
    attempt: { id: a.id, number: a.attempt_no, status: a.status },
    reservation: { id: r.id, connectorId: r.connector_id, state: r.state },
    ...(p.status === "pending" && !providerSuccess && a.status === "pending"
      ? { confirmationUrl: confirmationUrl(options, a.id, a.confirmation_url) }
      : {}),
  };
}
async function newAttempt(
  db: PoolClient,
  options: PaymentOptions,
  id: string,
  no: number,
  retryKey: string | null,
) {
  const attemptId = randomUUID();
  await db.query(
    `INSERT INTO payment_attempts(id,payment_id,attempt_no,retry_key,provider_payment_id,confirmation_url)
    VALUES ($1::uuid,$2,$3,$4,$1::uuid::text,$5)`,
    [
      attemptId,
      id,
      no,
      retryKey,
      `${options.publicOrigin}/api/test-payments/${attemptId}`,
    ],
  );
}

export async function createPayment(
  pool: Database,
  options: PaymentOptions,
  userId: string,
  key: unknown,
  raw: unknown,
) {
  const requestKey = idempotencyKey.parse(key),
    parsed = paymentInput.parse(raw).input;
  const input = { ...parsed, start: new Date(parsed.start).toISOString() };
  const requestHash = hash(
    JSON.stringify({
      stationId: input.stationId,
      connector: input.connector,
      start: input.start,
      duration: input.duration,
      payment: input.payment,
    }),
  );
  return work(pool, async (db) => {
    // Serializes creates for this user; UNIQUE(user_id,key) remains the database backstop.
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",
      [`payment-user:${userId}`],
    );
    const existing = (
      await db.query(
        "SELECT * FROM payments WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE",
        [userId, requestKey],
      )
    ).rows[0];
    if (existing) {
      if (existing.request_hash !== requestHash)
        throw new HttpError(409, "Ключ уже использован для другого заказа.");
      return {
        created: false,
        payment: await dto(db, await expire(db, existing), options),
      };
    }
    const start = new Date(input.start),
      end = new Date(start.getTime() + input.duration * 60000);
    validateInterval(start, end, await databaseNow(db));
    const overlap = await db.query(
      `SELECT 1 FROM payments WHERE user_id=$1 AND status='pending' AND expires_at>clock_timestamp()
      AND tstzrange(start_at,end_at,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)') LIMIT 1`,
      [userId, start, end],
    );
    if (overlap.rows.length)
      throw new HttpError(
        409,
        "У вас уже есть ожидающий платёж на этот интервал.",
      );
    const station = (
      await db.query(
        "SELECT organization_id FROM stations WHERE id=$1 AND archived_at IS NULL",
        [input.stationId],
      )
    ).rows[0];
    if (!station) throw new HttpError(404, "Станция не найдена.");
    // This new order is not visible to other transactions until its hold, quote and first attempt commit together.
    const held = await createHoldInTransaction(db, {
      organizationId: station.organization_id,
      stationId: input.stationId,
      connector: input.connector,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      ttlSeconds: options.holdTtlSeconds ?? 900,
    });
    const price = (
      await db.query(
        `SELECT c.max_power_kw,s.price_per_kwh_kopecks,d.battery_capacity_kwh FROM connectors c
      JOIN stations s ON s.id=c.station_id CROSS JOIN driver_profiles d WHERE c.id=$1 AND d.user_id=$2 FOR SHARE OF d`,
        [held.connectorId, userId],
      )
    ).rows[0];
    if (!price) throw new HttpError(409, "Профиль водителя не заполнен.");
    const q = quote(
        Number(price.max_power_kw),
        input.duration,
        Number(price.battery_capacity_kwh),
        price.price_per_kwh_kopecks,
      ),
      id = randomUUID();
    const p = (
      await db.query(
        `INSERT INTO payments(id,user_id,organization_id,station_id,connector_id,requested_connector_type,start_at,end_at,
      method,amount_kopecks,quoted_tariff_kopecks,quoted_energy_kwh,idempotency_key,request_hash,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [
          id,
          userId,
          station.organization_id,
          input.stationId,
          held.connectorId,
          input.connector,
          start,
          end,
          input.payment,
          q.amountKopecks,
          price.price_per_kwh_kopecks,
          q.energyKwh,
          requestKey,
          requestHash,
          new Date(held.expiresAt!),
        ],
      )
    ).rows[0];
    await db.query(
      "UPDATE connector_reservations SET payment_id=$2 WHERE id=$1",
      [held.id, id],
    );
    await newAttempt(db, options, id, 1, null);
    return { created: true, payment: await dto(db, p, options) };
  });
}
export function getPayment(
  pool: Database,
  options: PaymentOptions,
  userId: string,
  id: string,
) {
  return work(pool, async (db) =>
    dto(db, await expire(db, await lockOrder(db, id, userId)), options),
  );
}
export async function retryPayment(
  pool: Database,
  options: PaymentOptions,
  userId: string,
  id: string,
  key: unknown,
) {
  const retryKey = idempotencyKey.parse(key);
  const result = await work(pool, async (db) => {
    const p = await expire(db, await lockOrder(db, id, userId));
    const replay = await db.query(
      "SELECT id FROM payment_attempts WHERE payment_id=$1 AND retry_key=$2",
      [id, retryKey],
    );
    if (replay.rows.length) return dto(db, p, options);
    if (
      p.status !== "failed" ||
      p.failure_code !== "provider_failed" ||
      p.provider_success_received_at ||
      p.expires_at <= (await databaseNow(db))
    )
      return new HttpError(409, "Повтор этой оплаты сейчас недоступен.");
    const r = await reservation(db, id);
    await createHoldInTransaction(
      db,
      {
        organizationId: p.organization_id,
        stationId: p.station_id,
        connectorId: p.connector_id,
        connector: p.requested_connector_type,
        startAt: p.start_at.toISOString(),
        endAt: p.end_at.toISOString(),
      },
      { id: r.id, expiresAt: p.expires_at },
    );
    await newAttempt(
      db,
      options,
      id,
      (await latest(db, id)).attempt_no + 1,
      retryKey,
    );
    const updated = (
      await db.query(
        "UPDATE payments SET status='pending',failure_code=NULL WHERE id=$1 RETURNING *",
        [id],
      )
    ).rows[0];
    return dto(db, updated, options);
  });
  if (result instanceof HttpError) throw result;
  return result;
}
export async function cancelPayment(
  pool: Database,
  options: PaymentOptions,
  userId: string,
  id: string,
) {
  const result = await work(pool, async (db) => {
    const p = await expire(db, await lockOrder(db, id, userId));
    if (p.provider_success_received_at)
      return new HttpError(
        409,
        "Результат провайдера уже получен; требуется финализация.",
      );
    if (p.status === "cancelled" || p.failure_code === "expired")
      return dto(db, p, options);
    const r = await reservation(db, id);
    await releaseHoldInTransaction(db, p.organization_id, r.id);
    await db.query(
      "UPDATE payment_attempts SET status='cancelled',resolved_at=clock_timestamp() WHERE payment_id=$1 AND status='pending'",
      [id],
    );
    return dto(
      db,
      (
        await db.query(
          "UPDATE payments SET status='cancelled',failure_code='cancelled' WHERE id=$1 RETURNING *",
          [id],
        )
      ).rows[0],
      options,
    );
  });
  if (result instanceof HttpError) throw result;
  return result;
}

export async function processSignedEvent(
  pool: Database,
  options: PaymentOptions,
  body: Buffer,
  timestamp: unknown,
  signature: unknown,
) {
  verifyEvent(options, body, timestamp, signature);
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Некорректное событие.");
  }
  const event = providerEvent.parse(json),
    requestHash = hash(JSON.stringify(event));
  return work(pool, async (db) => {
    const a = (
      await db.query(
        "SELECT * FROM payment_attempts WHERE provider='test' AND provider_payment_id=$1",
        [event.providerPaymentId],
      )
    ).rows[0];
    if (!a) throw new HttpError(404, "Попытка провайдера не найдена.");
    let p = await lockOrder(db, a.payment_id);
    if (Number(p.amount_kopecks) !== event.amountKopecks)
      throw new HttpError(409, "Сумма события не соответствует заказу.");
    const inserted = await db.query(
      `INSERT INTO payment_events(attempt_id,provider_event_id,kind,request_hash,result)
      VALUES ($1,$2,$3,$4,'received') ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING id`,
      [a.id, event.providerEventId, event.outcome, requestHash],
    );
    if (!inserted.rows.length) {
      const old = (
        await db.query(
          "SELECT request_hash FROM payment_events WHERE provider='test' AND provider_event_id=$1",
          [event.providerEventId],
        )
      ).rows[0];
      if (old.request_hash !== requestHash)
        throw new HttpError(409, "ID события уже имеет другое содержимое.");
      return { received: true, duplicate: true };
    }
    p = await expire(db, p);
    const current = (
      await db.query("SELECT * FROM payment_attempts WHERE id=$1 FOR UPDATE", [
        a.id,
      ])
    ).rows[0];
    let result = "ignored_terminal";
    if (event.outcome === "succeeded") {
      if (
        !p.provider_success_received_at &&
        p.status === "pending" &&
        current.status === "pending"
      ) {
        await db.query(
          "UPDATE payment_attempts SET status='succeeded',resolved_at=clock_timestamp() WHERE id=$1",
          [a.id],
        );
        await db.query(
          "UPDATE payments SET provider_success_received_at=clock_timestamp() WHERE id=$1",
          [p.id],
        );
        result = "awaiting_booking";
      } else if (!p.provider_success_received_at) {
        await db.query(
          "UPDATE payments SET provider_success_received_at=clock_timestamp(),requires_reconciliation=true,status=CASE WHEN status='pending' THEN 'failed' ELSE status END,failure_code=COALESCE(failure_code,'provider_failed') WHERE id=$1",
          [p.id],
        );
        await db.query(
          "UPDATE payment_attempts SET status='cancelled',resolved_at=clock_timestamp() WHERE payment_id=$1 AND status='pending'",
          [p.id],
        );
        const r = await reservation(db, p.id);
        await releaseHoldInTransaction(db, p.organization_id, r.id);
        result = "late_success";
      }
    } else if (
      !p.provider_success_received_at &&
      p.status === "pending" &&
      current.status === "pending"
    ) {
      const r = await reservation(db, p.id);
      await releaseHoldInTransaction(db, p.organization_id, r.id);
      await db.query(
        "UPDATE payment_attempts SET status=$2,resolved_at=clock_timestamp() WHERE id=$1",
        [a.id, event.outcome],
      );
      await db.query(
        "UPDATE payments SET status=$2,failure_code=$3 WHERE id=$1",
        [
          p.id,
          event.outcome,
          event.outcome === "failed" ? "provider_failed" : "cancelled",
        ],
      );
      result = "applied";
    }
    await db.query(
      "UPDATE payment_events SET result=$2,processed_at=clock_timestamp() WHERE id=$1",
      [inserted.rows[0].id, result],
    );
    return { received: true, duplicate: false, result };
  });
}

export async function checkoutState(
  pool: Database,
  options: PaymentOptions,
  attemptId: string,
) {
  z.uuid().parse(attemptId);
  return work(pool, async (db) => {
    const a = (
      await db.query("SELECT * FROM payment_attempts WHERE id=$1", [attemptId])
    ).rows[0];
    if (!a) throw new HttpError(404, "Попытка не найдена.");
    const p = await expire(db, await lockOrder(db, a.payment_id));
    return {
      payment: await dto(db, p, options),
      providerPaymentId: a.provider_payment_id,
      expired: p.expires_at <= (await databaseNow(db)),
    };
  });
}
