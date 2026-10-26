import express, { Router } from "express";
import { z } from "zod";
import type { Database } from "../../db/pool.js";
import { HttpError } from "../../middleware/errors.js";
import {
  createPayment,
  getPayment,
  retryPayment,
  cancelPayment,
  processSignedEvent,
  checkoutState,
} from "./service.js";
import { emptyBody, idempotencyKey, paymentInput } from "./validation.js";
import { verifyCheckout, signEvent, type PaymentOptions } from "./provider.js";

function enabled(options: PaymentOptions | undefined): PaymentOptions {
  if (!options) throw new HttpError(503, "Тестовый провайдер не настроен.");
  return options;
}
export function paymentRoutes(pool: Database, options?: PaymentOptions) {
  const router = Router();
  router.use((req, _res, next) => {
    if (req.identity?.role !== "driver")
      throw new HttpError(403, "Доступно только водителю.");
    next();
  });
  router.post("/", async (req, res) => {
    const body = paymentInput.parse(req.body),
      key = idempotencyKey.parse(req.get("Idempotency-Key"));
    const result = await createPayment(
      pool,
      enabled(options),
      req.identity!.id,
      key,
      body,
    );
    res.status(result.created ? 201 : 200).json(result.payment);
  });
  router.get("/:id", async (req, res) =>
    res.json(
      await getPayment(
        pool,
        enabled(options),
        req.identity!.id,
        z.uuid().parse(req.params.id),
      ),
    ),
  );
  router.post("/:id/retry", async (req, res) => {
    emptyBody.parse(req.body ?? {});
    const key = idempotencyKey.parse(req.get("Idempotency-Key"));
    res.json(
      await retryPayment(
        pool,
        enabled(options),
        req.identity!.id,
        z.uuid().parse(req.params.id),
        key,
      ),
    );
  });
  router.post("/:id/cancel", async (req, res) => {
    emptyBody.parse(req.body ?? {});
    res.json(
      await cancelPayment(
        pool,
        enabled(options),
        req.identity!.id,
        z.uuid().parse(req.params.id),
      ),
    );
  });
  return router;
}
export function webhookRoute(pool: Database, options?: PaymentOptions) {
  return Router().post(
    "/",
    express.raw({ type: "application/json", limit: "4kb", inflate: false }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body))
        throw new HttpError(400, "Ожидается JSON-событие.");
      res.json(
        await processSignedEvent(
          pool,
          enabled(options),
          req.body,
          req.get("X-Test-Payment-Timestamp"),
          req.get("X-Test-Payment-Signature"),
        ),
      );
    },
  );
}
function page(
  amount: number,
  message: string,
  attemptId: string,
  token: string,
  canAct: boolean,
) {
  // All variable strings below are validated UUID/hex or server-owned constant text.
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Тестовая оплата — Энерготранспорт</title>
  <style>body{font:16px/1.6 system-ui,sans-serif;background:#f2f4f2;color:#172b25;margin:0;padding:48px 20px}main{max-width:580px;margin:0 auto;background:white;border:1px solid #d7ded9;border-radius:12px;padding:32px}h1{font-size:28px;line-height:1.2}small{color:#77642f}strong{font-size:30px}button{font:inherit;cursor:pointer;border:1px solid #c5d2c9;background:white;color:#133e2f;padding:12px 18px;border-radius:6px;margin:5px 5px 0 0}button:first-of-type{background:#176c4b;color:white;border-color:#176c4b}.note{color:#5a6660;font-size:14px}</style>
  <main><small>УЧЕБНЫЙ СТЕНД · ТЕСТОВЫЙ ПРОВАЙДЕР</small><h1>Тестовая оплата</h1><strong>${(amount / 100).toFixed(2)} ₽</strong><p role="status">${message}</p>
  <p class="note">Деньги не списываются. Номер карты и CVV не нужны. На этом этапе результат провайдера сохраняется отдельно; подтверждённая бронь ещё не создаётся.</p>
  ${canAct ? `<form method="post" action="/api/test-payments/${attemptId}"><input type="hidden" name="token" value="${token}"><button name="outcome" value="succeeded">Симулировать успех</button><button name="outcome" value="failed">Симулировать отказ</button><button name="outcome" value="cancelled">Отменить</button></form>` : ""}
  <p class="note">Можно закрыть эту вкладку и проверить статус в приложении.</p></main></html>`;
}
export function testProviderRoutes(pool: Database, options?: PaymentOptions) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  router.get("/:id", async (req, res) => {
    const cfg = enabled(options),
      id = z.uuid().parse(req.params.id);
    verifyCheckout(cfg, id, req.query.token);
    const state = await checkoutState(pool, cfg, id),
      p = state.payment;
    const active =
      p.status === "pending" &&
      !p.providerSuccessReceived &&
      p.attempt.id === id &&
      p.attempt.status === "pending";
    res
      .type("html")
      .send(
        page(
          p.amountKopecks,
          p.awaitingFinalization
            ? "Результат провайдера принят. Ожидается этап подтверждения брони."
            : p.reconciliationRequired
              ? "Результат сохранён для последующей сверки. Повторять оплату не нужно."
              : active
                ? "Выберите результат тестовой попытки."
                : "Эта попытка уже завершена или срок ожидания истёк.",
          id,
          String(req.query.token),
          active,
        ),
      );
  });
  router.post(
    "/:id",
    express.urlencoded({ extended: false, limit: "2kb" }),
    async (req, res) => {
      const cfg = enabled(options),
        id = z.uuid().parse(req.params.id);
      if (req.get("Origin") && req.get("Origin") !== cfg.publicOrigin)
        throw new HttpError(403, "Источник формы не разрешён.");
      const input = z
        .object({
          token: z.string(),
          outcome: z.enum(["succeeded", "failed", "cancelled"]),
        })
        .strict()
        .parse(req.body);
      verifyCheckout(cfg, id, input.token);
      const state = await checkoutState(pool, cfg, id);
      if (state.expired)
        throw new HttpError(409, "Срок тестовой попытки истёк.");
      const signed = signEvent(cfg, {
        providerEventId: `test-${id}-${input.outcome}`,
        providerPaymentId: state.providerPaymentId,
        outcome: input.outcome,
        amountKopecks: state.payment.amountKopecks,
        currency: "RUB",
      });
      // In-process test adapter delivers through the same signed inbox as the HTTP webhook. No network side effect inside a DB transaction.
      const result = await processSignedEvent(
        pool,
        cfg,
        signed.body,
        signed.timestamp,
        signed.signature,
      );
      res
        .type("html")
        .send(
          page(
            state.payment.amountKopecks,
            result.result === "awaiting_booking"
              ? "Тестовый успех принят. Финализация и создание брони появятся на следующем этапе."
              : "Тестовое событие сохранено. Проверьте обновлённый статус платежа.",
            id,
            input.token,
            false,
          ),
        );
    },
  );
  return router;
}
