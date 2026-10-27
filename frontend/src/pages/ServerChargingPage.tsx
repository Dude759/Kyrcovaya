import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { EmptyState, ErrorMessage } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { useAction } from "../hooks/useAction";
import { useNow } from "../hooks/useNow";
import { useApp } from "../state/context";
import { api } from "../services/api";
import { errorMessage } from "../services/errors";
import { moneyPrecise, dateTime, downloadCsv } from "../utils/format";
import type { Session } from "../types/domain";
import { serverSessionLabels } from "../utils/session-status";

export function ServerChargingPage() {
  const { data, refresh } = useApp(),
    [params] = useSearchParams(),
    now = useNow();
  const id =
    params.get("session") ??
    data?.sessions.find((s) =>
      ["starting", "active", "stopping"].includes(s.status),
    )?.id;
  const [session, setSession] = useState<Session | null>(null),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [stopOpen, setStopOpen] = useState(false);
  const action = useAction(),
    stopKey = useRef(crypto.randomUUID()),
    lastStatus = useRef("");
  useEffect(() => {
    if (!id) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const value = await api.session(id!);
        if (cancelled) return;
        setSession(value);
        setError("");
        const status = `${value.status}:${value.refund?.status ?? ""}`;
        if (lastStatus.current !== status) {
          lastStatus.current = status;
          void refresh();
        }
        if (
          ["starting", "active", "stopping"].includes(value.status) ||
          (value.refund && value.refund.status !== "succeeded")
        )
          timer = setTimeout(() => void read(), 3000);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    }
    void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, retry, refresh]);
  const station = data?.stations.find((s) => s.id === session?.stationId),
    sample = session?.telemetry;
  const terminal =
    !!session && ["completed", "failed"].includes(session.status);
  const fresh =
    !!sample &&
    sample.connection === "online" &&
    now - Date.parse(sample.receivedAt) <= 60000;
  const title = session
    ? serverSessionLabels[session.status]
    : "Зарядная сессия";
  return (
    <AppShell
      role="driver"
      active="sessions"
      title={title}
      subtitle={
        station
          ? `${station.name} · ${session?.connector}`
          : "Серверный имитатор зарядной станции"
      }
    >
      <ErrorMessage message={error} />
      {error && (
        <button
          className="button button--outline"
          onClick={() => setRetry((n) => n + 1)}
        >
          Повторить проверку
        </button>
      )}
      {!id ? (
        <EmptyState
          title="Активной зарядки нет"
          to="/driver/bookings"
          label="Мои брони"
        />
      ) : !session ? (
        <p role="status">Получаем состояние сессии…</p>
      ) : (
        <div className="charging-layout">
          <section className="session-panel">
            <div
              className={`telemetry-notice telemetry-notice--${terminal ? "completed" : fresh ? "online" : sample?.connection === "offline" ? "offline" : "stale"}`}
              role="status"
            >
              <strong>
                {terminal
                  ? "Итоговые показания имитатора"
                  : fresh
                    ? "Показания обновляются"
                    : sample?.connection === "offline"
                      ? "Нет связи с имитатором"
                      : "Нет свежих показаний · более 60 секунд либо запуск ещё не подтверждён"}
              </strong>
              <p>
                Серверный имитатор. Реальная зарядная станция не подключена.
              </p>
              {sample && (
                <small>
                  Последнее измерение: {dateTime(sample.receivedAt)}
                </small>
              )}
              {!terminal && !fresh && (
                <p>
                  Сохранена последняя измеренная энергия. Текущая мощность
                  неизвестна.
                </p>
              )}
              {session.telemetryGap && (
                <p>
                  Во время перерыва показания не формировались. Пропущенный
                  период не начислен.
                </p>
              )}
            </div>
            <span
              className={`status status--${session.status === "active" ? "available" : "service"}`}
            >
              {title}
            </span>
            <h2>{terminal ? "Итог сессии" : "Измерения зарядки"}</h2>
            <p>
              Заряд батареи: нет измерения SOC. Значения профиля не используются
              как показания устройства.
            </p>
            <dl className="session-stats">
              <div>
                <dt>{sample ? `${session.energy.toFixed(3)} кВт⋅ч` : "—"}</dt>
                <dd>Измеренная энергия</dd>
              </div>
              <div>
                <dt>
                  {!terminal &&
                  fresh &&
                  typeof session.currentPowerKw === "number"
                    ? `${session.currentPowerKw} кВт`
                    : "—"}
                </dt>
                <dd>Текущая мощность</dd>
              </div>
              <div>
                <dt>
                  {moneyPrecise(
                    (session.settlement?.finalCostKopecks ??
                      session.costKopecks ??
                      0) / 100,
                  )}
                </dt>
                <dd>
                  {session.settlement
                    ? "Окончательная стоимость"
                    : "Накопленная стоимость"}
                </dd>
              </div>
            </dl>
            {!stopOpen && <ErrorMessage message={action.error} />}
            {session.status === "starting" && (
              <p>
                Команда сохранена. Начало зарядки ещё не подтверждено
                имитатором.
              </p>
            )}
            {session.status === "stopping" && (
              <p>
                Команда остановки сохранена. Ожидаем ответ имитатора и последнее
                измерение; итог ещё не зафиксирован.
              </p>
            )}
            {session.status === "failed" && (
              <p>
                Имитатор отказал в запуске. Сессия закрыта без поставки энергии.
              </p>
            )}
            {["starting", "active"].includes(session.status) && (
              <button
                className="button button--outline button--full"
                onClick={() => setStopOpen(true)}
              >
                Остановить зарядку
              </button>
            )}
            {session.settlement && (
              <>
                <dl className="details-list">
                  <div>
                    <dt>Предоплата</dt>
                    <dd>
                      {moneyPrecise(session.settlement.prepaidKopecks / 100)}
                    </dd>
                  </div>
                  <div>
                    <dt>Неиспользованный остаток</dt>
                    <dd>
                      {moneyPrecise(session.settlement.unusedKopecks / 100)}
                    </dd>
                  </div>
                </dl>
                <p role="status">
                  {session.refund
                    ? session.refund.status === "succeeded"
                      ? `Тестовый возврат подтверждён: ${moneyPrecise(session.refund.amountKopecks / 100)}`
                      : "Возврат остатка ожидается. Подтверждение тестового адаптера ещё не получено."
                    : "Неиспользованного остатка нет; возврат не требуется."}
                </p>
                <button
                  className="button button--outline"
                  onClick={() =>
                    downloadCsv(`session-${session.id}.csv`, [
                      [
                        "Документ",
                        "Отчёт серверного имитатора · тестовые деньги",
                      ],
                      ["ID", session.id],
                      ["Энергия, Вт⋅ч", session.energyWh ?? 0],
                      ["Тариф, коп/кВт⋅ч", session.tariffKopecks ?? 0],
                      ["Итог, коп", session.settlement!.finalCostKopecks],
                      ["Остаток, коп", session.settlement!.unusedKopecks],
                      ["Источник", "simulator"],
                    ])
                  }
                >
                  Скачать отчёт о сессии
                </button>
              </>
            )}
            <Link className="text-link" to="/driver/sessions">
              Все сессии →
            </Link>
          </section>
          <aside className="session-details">
            <h2>Детали сессии</h2>
            <strong>{station?.name ?? "Станция"}</strong>
            <small>{station?.address}</small>
            <hr />
            <dl>
              <div>
                <dt>Физический порт</dt>
                <dd style={{ overflowWrap: "anywhere" }}>
                  {session.connectorId}
                </dd>
              </div>
              <div>
                <dt>Тариф</dt>
                <dd>{moneyPrecise(session.tariff)} / кВт⋅ч</dd>
              </div>
              <div>
                <dt>Подтверждённый запуск</dt>
                <dd>
                  {session.startConfirmedAt
                    ? dateTime(session.startConfirmedAt)
                    : "Ещё не подтверждён"}
                </dd>
              </div>
              <div>
                <dt>Подтверждённая остановка</dt>
                <dd>
                  {session.endedAt
                    ? dateTime(session.endedAt)
                    : "Ещё не подтверждена"}
                </dd>
              </div>
              <div>
                <dt>Оплаченный предел энергии</dt>
                <dd>
                  {((session.energyBudgetWh ?? 0) / 1000).toFixed(3)} кВт⋅ч
                </dd>
              </div>
            </dl>
            <p>
              Мощность ограничена параметрами порта и локальным лимитом станции.
              Управление энергосистемой не подключено.
            </p>
          </aside>
        </div>
      )}
      {stopOpen && session && (
        <Modal
          title="Запросить остановку зарядки?"
          onClose={() => !action.busy && setStopOpen(false)}
        >
          <p>
            Окончательный расчёт появится после подтверждения имитатора и
            последнего измерения.
          </p>
          <ErrorMessage message={action.error} />
          <button
            className="button button--full"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const result = await api.stop(session.id, stopKey.current);
                setSession(result);
                setStopOpen(false);
                setRetry((n) => n + 1);
                await refresh();
              })
            }
          >
            {action.busy ? "Отправляем…" : "Запросить остановку"}
          </button>
        </Modal>
      )}
    </AppShell>
  );
}
