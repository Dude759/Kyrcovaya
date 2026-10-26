import { useEffect, useState, useRef } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { ErrorMessage } from "../components/Feedback";
import { useAction } from "../hooks/useAction";
import { useNow } from "../hooks/useNow";
import { api, apiMode } from "../services/api";
import { errorMessage } from "../services/errors";
import { useApp } from "../state/context";
import type { Payment } from "../types/domain";
import { dateTime, money } from "../utils/format";

export function CheckoutPage() {
  const { paymentId } = useParams();
  return <Checkout paymentId={paymentId!} key={paymentId} />;
}

function Checkout({ paymentId }: { paymentId: string }) {
  const { data, refresh } = useApp();
  const [payment, setPayment] = useState<Payment | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const action = useAction();
  const now = useNow();
  const retryKey = useRef(crypto.randomUUID());
  useEffect(() => {
    retryKey.current = crypto.randomUUID();
  }, [payment?.attempt?.id]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await api.payment(paymentId!);
        if (cancelled) return;
        if (result.status === "succeeded") await refresh();
        if (cancelled) return;
        setPayment(result);
        setError("");
        if (result.status === "pending" && !result.providerSuccessReceived)
          timer = setTimeout(() => void load(), 5000);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [paymentId, retry, refresh]);
  async function update(operation: () => Promise<Payment>) {
    await action.run(async () => {
      const result = await operation();
      await refresh();
      setPayment(result);
      setRetry((n) => n + 1);
    });
  }
  if (
    payment?.status === "succeeded" &&
    payment.bookingId &&
    data?.bookings.some((b) => b.id === payment.bookingId)
  )
    return <Navigate to={`/driver/payment/${payment.bookingId}`} replace />;
  const expired = payment ? Date.parse(payment.expiresAt) <= now : false;
  const reconciliation =
    payment?.reconciliationRequired ||
    (payment?.providerSuccessReceived && expired);
  const awaiting = payment?.awaitingFinalization && !expired;
  const status =
    expired && (payment?.status === "pending" || payment?.status === "failed")
      ? "cancelled"
      : payment?.status;
  const title = reconciliation
    ? "Тестовый результат требует сверки"
    : awaiting
      ? "Результат провайдера принят"
      : status === "failed"
        ? "Оплата не прошла"
        : status === "cancelled"
          ? "Оплата отменена"
          : status === "succeeded"
            ? "Оплата подтверждена"
            : "Подтверждение оплаты";
  const station = data?.stations.find((s) => s.id === payment?.input.stationId);
  const confirmationUrl = payment?.confirmationUrl?.startsWith("https://")
    ? payment.confirmationUrl
    : undefined;
  return (
    <AppShell
      role="driver"
      active="bookings"
      title="Оплата бронирования"
      subtitle={
        payment?.test
          ? "Тестовая оплата: статус заказа и результат провайдера"
          : "Проверяем статус и подтверждаем бронь"
      }
    >
      <section className="checkout-card" aria-busy={action.busy}>
        <span
          className={`status status--${status === "failed" ? "offline" : "service"}`}
        >
          {awaiting
            ? "Ожидает финализации"
            : reconciliation
              ? "Требуется сверка"
              : status === "pending"
                ? "Ожидает оплаты"
                : status === "failed"
                  ? "Отклонена"
                  : status === "cancelled"
                    ? "Отменена"
                    : "Проверка статуса"}
        </span>
        <h2>{title}</h2>
        {!payment && !error && <p role="status">Загружаем платёж…</p>}
        <ErrorMessage message={error} />
        {error && (
          <button
            className="button button--outline"
            onClick={() => setRetry((n) => n + 1)}
          >
            Проверить ещё раз
          </button>
        )}
        {payment && (
          <>
            {status === "succeeded" && (
              <div role="status">
                <p>
                  Оплата подтверждена. Получаем данные брони. Повторный платёж
                  не требуется.
                </p>
                <button
                  className="button button--outline"
                  disabled={action.busy}
                  onClick={() => void action.run(refresh)}
                >
                  Обновить бронирование
                </button>
              </div>
            )}
            <p>
              {station?.name ?? "Зарядная станция"} · {payment.input.connector}
            </p>
            <dl className="details-list">
              <div>
                <dt>Время брони</dt>
                <dd>{dateTime(payment.input.start)}</dd>
              </div>
              <div>
                <dt>Способ оплаты</dt>
                <dd>
                  {payment.input.payment === "card"
                    ? "Банковская карта"
                    : "СБП"}
                </dd>
              </div>
              <div>
                <dt>Предварительная сумма</dt>
                <dd>{money(payment.amount)}</dd>
              </div>
            </dl>
            {status === "pending" && (
              <>
                <p role="status">
                  {awaiting
                    ? "Тестовый провайдер сообщил об успехе. Подтверждённая бронь ещё не создана: финализация появится на следующем этапе. Повторять оплату не нужно."
                    : reconciliation
                      ? "Тестовый результат сохранён для сверки. Бронь не подтверждена; повторять оплату не нужно."
                      : "Ожидаем результат провайдера. Не создавайте новый платёж, пока проверяется этот."}
                </p>
                <small>
                  До {dateTime(payment.expiresAt)} · окончательная стоимость
                  зависит от полученной энергии.
                </small>
                {payment.providerSuccessReceived ? (
                  <p className="demo-note">
                    Тестовый режим: деньги не списываются, банковские реквизиты
                    не используются.
                  </p>
                ) : apiMode === "mock" ? (
                  <div className="demo-checkout">
                    <p className="demo-note">
                      Тестовый платёж. Деньги не списываются, данные карты не
                      нужны. Выберите результат, чтобы проверить сценарий.
                    </p>
                    <div className="checkout-actions">
                      <button
                        className="button"
                        disabled={action.busy || expired}
                        onClick={() =>
                          void update(() =>
                            api.simulatePayment(payment.id, "succeeded"),
                          )
                        }
                      >
                        Подтвердить тестовую оплату
                      </button>
                      <button
                        className="button button--outline"
                        disabled={action.busy || expired}
                        onClick={() =>
                          void update(() =>
                            api.simulatePayment(payment.id, "failed"),
                          )
                        }
                      >
                        Проверить отказ
                      </button>
                    </div>
                  </div>
                ) : confirmationUrl ? (
                  <a
                    className="button"
                    href={confirmationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Открыть страницу оплаты ↗
                  </a>
                ) : (
                  <p>
                    Страница оплаты пока недоступна. Можно проверить статус или
                    вернуться к бронированию.
                  </p>
                )}
                <div className="checkout-actions">
                  <button
                    className="text-link"
                    disabled={action.busy}
                    onClick={() => setRetry((n) => n + 1)}
                  >
                    Проверить статус
                  </button>
                  {!payment.providerSuccessReceived && (
                    <button
                      className="text-link"
                      disabled={action.busy}
                      onClick={() =>
                        void update(() => api.cancelPayment(payment.id))
                      }
                    >
                      Отменить оплату
                    </button>
                  )}
                </div>
              </>
            )}
            {status === "failed" && (
              <>
                <p role="alert">{payment.failure}</p>
                {!payment.providerSuccessReceived && (
                  <button
                    className="button"
                    disabled={action.busy || expired}
                    onClick={() =>
                      void update(() =>
                        api.retryPayment(payment.id, retryKey.current),
                      )
                    }
                  >
                    {action.busy ? "Повторяем…" : "Повторить оплату"}
                  </button>
                )}
                {payment.providerSuccessReceived && (
                  <p>
                    Результат тестового провайдера сохранён для сверки.
                    Подтверждённая бронь не создана; повторять оплату не нужно.
                  </p>
                )}
              </>
            )}
            {status === "cancelled" && (
              <p>
                {reconciliation
                  ? "Результат тестового провайдера сохранён для сверки. Бронь не подтверждена; повторять оплату не нужно."
                  : `${expired ? "Время ожидания истекло." : "Бронь не создана."} Вы можете выбрать другое время или способ оплаты.`}
              </p>
            )}
            <ErrorMessage message={action.error} />
          </>
        )}
        <Link
          className="access-back"
          to={
            station
              ? `/driver/booking?station=${station.id}`
              : "/driver/stations"
          }
        >
          ← К выбору времени и способа оплаты
        </Link>
      </section>
    </AppShell>
  );
}
