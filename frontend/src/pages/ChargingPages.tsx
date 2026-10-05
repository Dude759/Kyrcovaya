import { useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { EmptyState, ErrorMessage } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { useNow } from "../hooks/useNow";
import { useAction } from "../hooks/useAction";
import { api, apiMode } from "../services/api";
import { useApp } from "../state/context";
import {
  dateTime,
  downloadCsv,
  money,
  displaySessionMetrics as sessionMetrics,
  telemetryState,
  today,
} from "../utils/format";
import type { Booking, Session } from "../types/domain";

export function BookingPage() {
  const { data, user } = useApp();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const action = useAction();
  const station = data!.stations.find((s) => s.id === params.get("station"));
  const [connectorType, setConnector] = useState(
    station?.connectors.find((c) => c.available > 0)?.type ?? "CCS2",
  );
  const [suggestedStart] = useState(() => new Date(Date.now() + 5 * 60000));
  const [date, setDate] = useState(() =>
    suggestedStart.toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" }),
  );
  const [maxDate] = useState(() =>
    new Date(Date.now() + 3 * 86400000).toLocaleDateString("en-CA", {
      timeZone: "Europe/Moscow",
    }),
  );
  const [time, setTime] = useState(() => {
    const next = suggestedStart;
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Moscow",
    }).format(next);
  });
  const [duration, setDuration] = useState(45);
  const [payment, setPayment] = useState<"card" | "sbp">("card");
  const [open, setOpen] = useState(false);
  const paymentAttempt = useRef({ signature: "", key: crypto.randomUUID() });
  if (!station)
    return (
      <AppShell
        role="driver"
        active="bookings"
        title="Новая бронь"
        subtitle="Выберите станцию на карте"
      >
        <EmptyState title="Сначала выберите станцию" to="/driver/stations" />
      </AppShell>
    );
  const connector = station.connectors.find((c) => c.type === connectorType);
  const canBook =
    !!connector?.available && !["offline", "service"].includes(station.status);
  const estimatedEnergy = Math.min(
    (((connector?.powerKw ?? 0) * duration) / 60) * 0.65,
    user!.battery * 0.3,
  );
  const amount = Math.round(estimatedEnergy * station.pricePerKwh);
  const start = `${date}T${time}:00+03:00`;
  const end = new Date(Date.parse(start) + duration * 60000);
  async function pay() {
    const input = {
      stationId: station!.id,
      connector: connectorType,
      start,
      duration,
      payment,
    };
    const signature = JSON.stringify(input);
    if (paymentAttempt.current.signature !== signature)
      paymentAttempt.current = { signature, key: crypto.randomUUID() };
    const result = await action.run(() =>
      api.checkout(input, paymentAttempt.current.key),
    );
    if (result) {
      setOpen(false);
      navigate(`/driver/checkout/${result.id}`);
    }
  }
  return (
    <AppShell
      role="driver"
      active="bookings"
      title="Бронирование"
      subtitle="Выберите разъём и удобное время"
    >
      <section className="booking-card">
        <div className="booking-steps">
          <span>
            01 <b>Станция</b>
          </span>
          <span className="is-active">
            02 <b>Время</b>
          </span>
          <span>
            03 <b>Оплата</b>
          </span>
        </div>
        <div className="booking-grid">
          <div className="booking-form">
            <h3>Разъём</h3>
            <div className="option-grid">
              {station.connectors.map((c) => (
                <button
                  className={connectorType === c.type ? "is-selected" : ""}
                  disabled={!c.available}
                  aria-pressed={connectorType === c.type}
                  onClick={() => setConnector(c.type)}
                  key={c.type}
                >
                  <strong>{c.type}</strong>
                  <small>
                    {c.powerKw} кВт · {c.available} свободно
                  </small>
                </button>
              ))}
            </div>
            <h3>Дата и время · Москва</h3>
            <div className="field-grid">
              <label className="field">
                <span>Дата</span>
                <input
                  type="date"
                  min={today()}
                  max={maxDate}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Начало</span>
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  required
                />
              </label>
            </div>
            <h3>Продолжительность</h3>
            <div className="choice-row">
              {[30, 45, 60, 90].map((v) => (
                <button
                  key={v}
                  aria-pressed={duration === v}
                  className={duration === v ? "is-selected" : ""}
                  onClick={() => setDuration(v)}
                >
                  {v} минут
                </button>
              ))}
            </div>
            <h3>Способ оплаты</h3>
            <div className="choice-row">
              <button
                aria-pressed={payment === "card"}
                className={payment === "card" ? "is-selected" : ""}
                onClick={() => setPayment("card")}
              >
                Карта
              </button>
              <button
                aria-pressed={payment === "sbp"}
                className={payment === "sbp" ? "is-selected" : ""}
                onClick={() => setPayment("sbp")}
              >
                СБП
              </button>
            </div>
          </div>
          <aside className="booking-summary">
            <h3>Ваша бронь</h3>
            <strong>{station.name}</strong>
            <p>{station.address}</p>
            <hr />
            <dl className="details-list">
              <div>
                <dt>Разъём</dt>
                <dd>
                  {connectorType} · {connector?.powerKw} кВт
                </dd>
              </div>
              <div>
                <dt>Дата</dt>
                <dd>
                  {Number.isFinite(Date.parse(start))
                    ? dateTime(start)
                    : "Выберите дату"}
                </dd>
              </div>
              <div>
                <dt>Время</dt>
                <dd>
                  {time}–
                  {Number.isFinite(end.getTime())
                    ? end.toLocaleTimeString("ru-RU", {
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: "Europe/Moscow",
                      })
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Тариф</dt>
                <dd>{station.pricePerKwh} ₽/кВт⋅ч</dd>
              </div>
            </dl>
            <hr />
            <span>Предварительно</span>
            <strong className="booking-price">≈ {money(amount)}</strong>
            <small>
              Расчёт для ≈ {estimatedEnergy.toFixed(1)} кВт⋅ч. Итог зависит от
              фактической энергии.
            </small>
            <ErrorMessage
              message={!canBook ? "Разъём сейчас недоступен." : action.error}
            />
            <button
              className="button button--full"
              disabled={!canBook || !time || !date}
              onClick={() => {
                if (
                  !Number.isFinite(Date.parse(start)) ||
                  Date.parse(start) <= Date.now()
                ) {
                  action.setError("Выберите время в будущем.");
                  return;
                }
                action.setError("");
                setOpen(true);
              }}
            >
              Перейти к оплате
            </button>
          </aside>
        </div>
      </section>
      {open && (
        <Modal
          title="Подтвердите бронирование"
          onClose={() => !action.busy && setOpen(false)}
        >
          <p>
            {station.name} · {dateTime(start)}
          </p>
          <div className="payment-method is-selected">
            <span>
              <strong>
                {payment === "card"
                  ? "Банковская карта"
                  : "Система быстрых платежей"}
              </strong>
              <small>
                {apiMode === "mock"
                  ? "Тестовый платёж · деньги не списываются"
                  : "Способ оплаты сохраняется в брони. Платёжный сервис пока не подключён."}
              </small>
            </span>
          </div>
          <div className="payment-total">
            <span>Предварительная сумма</span>
            <strong>{money(amount)}</strong>
          </div>
          <ErrorMessage message={action.error} />
          <button
            className="button button--full"
            disabled={action.busy}
            onClick={() => void pay()}
          >
            {action.busy
              ? "Подтверждаем…"
              : apiMode === "mock"
                ? "Открыть тестовую оплату"
                : "Продолжить оплату"}
          </button>
        </Modal>
      )}
    </AppShell>
  );
}

function BookingActions({ booking }: { booking: Booking }) {
  const { mutate } = useApp();
  const navigate = useNavigate();
  const action = useAction();
  const [cancelOpen, setCancelOpen] = useState(false);
  const now = useNow();
  const expired = Date.parse(booking.start) + booking.duration * 60000 < now;
  const canStart = Date.parse(booking.start) <= now + 15 * 60000 && !expired;
  async function start() {
    const result = await action.run(() =>
      mutate(() => api.start(booking.id), "Зарядка началась"),
    );
    if (result) navigate(`/driver/charging?session=${result.id}`);
  }
  return (
    <>
      <ErrorMessage message={action.error} />
      {booking.status === "confirmed" && (
        <div className="button-row wrap">
          <button
            className="button"
            disabled={action.busy || !canStart}
            onClick={() => void start()}
          >
            {expired
              ? "Время брони истекло"
              : canStart
                ? "Начать зарядку"
                : "Начало ближе ко времени брони"}
          </button>
          <button
            className="button button--outline"
            disabled={action.busy}
            onClick={() => setCancelOpen(true)}
          >
            Отменить бронь
          </button>
        </div>
      )}
      {cancelOpen && (
        <Modal
          title="Отменить бронирование?"
          onClose={() => !action.busy && setCancelOpen(false)}
        >
          <p>Разъём станет доступен другим водителям.</p>
          <ErrorMessage message={action.error} />
          <button
            className="button button--full"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await mutate(
                  () => api.cancel(booking.id),
                  "Бронирование отменено",
                );
                setCancelOpen(false);
              })
            }
          >
            {action.busy ? "Отменяем…" : "Подтвердить отмену"}
          </button>
        </Modal>
      )}
    </>
  );
}
export function PaymentResultPage() {
  const { bookingId } = useParams();
  const { data } = useApp();
  const booking = data!.bookings.find((b) => b.id === bookingId);
  const station = data!.stations.find((s) => s.id === booking?.stationId);
  return (
    <AppShell
      role="driver"
      active="bookings"
      title="Подтверждение бронирования"
      subtitle="Детали брони и оплаты"
    >
      {booking ? (
        <section className="result-card">
          <span
            className={`status status--${booking.status === "cancelled" ? "service" : "available"}`}
          >
            {booking.status === "cancelled"
              ? "Бронь отменена"
              : booking.status === "used"
                ? "Бронь использована"
                : "Бронь подтверждена"}
          </span>
          <h2>{station?.name}</h2>
          <p>{station?.address}</p>
          <dl className="details-list">
            <div>
              <dt>Время</dt>
              <dd>{dateTime(booking.start)}</dd>
            </div>
            <div>
              <dt>Разъём</dt>
              <dd>{booking.connector}</dd>
            </div>
            <div>
              <dt>Продолжительность</dt>
              <dd>{booking.duration} мин</dd>
            </div>
            <div>
              <dt>Предварительная сумма</dt>
              <dd>{money(booking.amount)}</dd>
            </div>
            <div>
              <dt>Способ оплаты</dt>
              <dd>{booking.payment === "card" ? "Карта" : "СБП"}</dd>
            </div>
          </dl>
          <BookingActions booking={booking} />
          <Link className="text-link" to="/driver/bookings">
            Все бронирования →
          </Link>
        </section>
      ) : (
        <EmptyState
          title="Бронирование не найдено"
          to="/driver/bookings"
          label="Мои брони"
        />
      )}
    </AppShell>
  );
}
export function BookingsPage() {
  const { data } = useApp();
  const [filter, setFilter] = useState("all");
  const now = useNow();
  const unfinished = (data!.payments ?? []).filter(
    (p) =>
      ["pending", "failed"].includes(p.status) && Date.parse(p.expiresAt) > now,
  );
  const bookings = data!.bookings.filter(
    (b) => filter === "all" || b.status === filter,
  );
  return (
    <AppShell
      role="driver"
      active="bookings"
      title="Мои бронирования"
      subtitle="Предстоящие зарядки и история броней"
    >
      <div className="page-toolbar">
        <div className="filters">
          {[
            ["all", "Все"],
            ["confirmed", "Предстоящие"],
            ["used", "Использованы"],
            ["cancelled", "Отменены"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? "is-active" : ""}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <Link className="button" to="/driver/stations">
          Новая бронь
        </Link>
      </div>
      <div className="record-grid">
        {filter === "all" &&
          unfinished.map((p) => (
            <article className="record-card" key={p.id}>
              <span className="status status--service">
                {p.status === "failed" ? "Оплата отклонена" : "Ожидает оплаты"}
              </span>
              <h2>
                {data!.stations.find((s) => s.id === p.input.stationId)?.name}
              </h2>
              <p>
                {dateTime(p.input.start)} · {p.input.duration} мин
              </p>
              <p>Бронь ещё не подтверждена · {money(p.amount)}</p>
              <Link
                className="button button--outline"
                to={`/driver/checkout/${p.id}`}
              >
                Вернуться к оплате
              </Link>
            </article>
          ))}
        {bookings.map((b) => (
          <article className="record-card" key={b.id}>
            <span
              className={`status status--${b.status === "confirmed" ? "available" : "service"}`}
            >
              {b.status === "confirmed"
                ? "Подтверждена"
                : b.status === "used"
                  ? "Использована"
                  : "Отменена"}
            </span>
            <h2>{data!.stations.find((s) => s.id === b.stationId)?.name}</h2>
            <p>
              {dateTime(b.start)} · {b.duration} мин
            </p>
            <dl className="details-list">
              <div>
                <dt>Разъём</dt>
                <dd>{b.connector}</dd>
              </div>
              <div>
                <dt>Предварительно</dt>
                <dd>{money(b.amount)}</dd>
              </div>
            </dl>
            <BookingActions booking={b} />
          </article>
        ))}
      </div>
      {!bookings.length && !(filter === "all" && unfinished.length) && (
        <EmptyState
          title="Бронирований пока нет"
          text="Выберите станцию и удобное время на карте."
          to="/driver/stations"
        />
      )}
    </AppShell>
  );
}
function ReceiptButton({ session }: { session: Session }) {
  const { data, user } = useApp();
  const station = data!.stations.find((s) => s.id === session.stationId);
  return (
    <button
      className="button button--outline"
      onClick={() =>
        downloadCsv(`session-${session.id}.csv`, [
          ["Документ", "Отчёт о зарядной сессии (демонстрационный)"],
          ["ID", session.id],
          ["Водитель", user!.name],
          ["Станция", station?.name ?? ""],
          ["Начало", dateTime(session.startedAt)],
          ["Окончание", session.endedAt ? dateTime(session.endedAt) : ""],
          ["Энергия, кВт⋅ч", session.energy.toFixed(2)],
          ["Тариф, ₽/кВт⋅ч", session.tariff],
          ["Сумма, ₽", Math.round(session.energy * session.tariff)],
        ])
      }
    >
      Скачать отчёт о сессии
    </button>
  );
}
export function SessionsPage() {
  const { data } = useApp();
  const now = useNow();
  return (
    <AppShell
      role="driver"
      active="sessions"
      title="Зарядные сессии"
      subtitle="Активная зарядка и история поездок"
    >
      <div className="record-grid">
        {data!.sessions.map((s) => (
          <article className="record-card" key={s.id}>
            <span
              className={`status status--${s.status === "active" ? "available" : "service"}`}
            >
              {s.status === "active" ? "Зарядка идёт" : "Завершена"}
            </span>
            <h2>
              {
                data!.stations.find((station) => station.id === s.stationId)
                  ?.name
              }
            </h2>
            <p>
              {dateTime(s.startedAt)} · {s.connector}
            </p>
            <dl className="details-list">
              <div>
                <dt>Энергия</dt>
                <dd>
                  {sessionMetrics(s, s.batteryCapacity, now).energy.toFixed(1)}{" "}
                  кВт⋅ч
                </dd>
              </div>
              <div>
                <dt>Стоимость</dt>
                <dd>
                  {money(sessionMetrics(s, s.batteryCapacity, now).amount)}
                </dd>
              </div>
            </dl>
            <Link className="button" to={`/driver/charging?session=${s.id}`}>
              Подробнее
            </Link>
            {s.status === "completed" && <ReceiptButton session={s} />}
          </article>
        ))}
      </div>
      {!data!.sessions.length && (
        <EmptyState
          title="Вы ещё не заряжались"
          text="Сессия появится после начала зарядки по вашей брони."
          to="/driver/bookings"
          label="Мои брони"
        />
      )}
    </AppShell>
  );
}
export function ChargingPage() {
  const { data, user, mutate } = useApp();
  const [params] = useSearchParams();
  const action = useAction();
  const [stopOpen, setStopOpen] = useState(false);
  const [support, setSupport] = useState(false);
  const now = useNow();
  const session =
    data!.sessions.find((s) => s.id === params.get("session")) ??
    (!params.get("session")
      ? data!.sessions.find((s) => s.status === "active")
      : undefined);

  if (!session)
    return (
      <AppShell
        role="driver"
        active="sessions"
        title="Зарядная сессия"
        subtitle="Статус зарядки"
      >
        <EmptyState
          title="Активной зарядки нет"
          to="/driver/bookings"
          label="Мои брони"
        />
      </AppShell>
    );
  const station = data!.stations.find((s) => s.id === session.stationId)!;
  const metrics = sessionMetrics(session, user!.battery, now);
  const active = session.status === "active";
  const connection = telemetryState(session, now);
  const connected = connection === "online";
  return (
    <AppShell
      role="driver"
      active="sessions"
      title={
        active
          ? connected
            ? "Зарядка идёт"
            : "Проверяем связь со станцией"
          : "Зарядка завершена"
      }
      subtitle={`${station.name} · ${session.connector}`}
    >
      <div className="charging-layout">
        <section className="session-panel">
          <div
            className={`telemetry-notice telemetry-notice--${connection}`}
            role="status"
          >
            <strong>
              {connection === "offline"
                ? "Нет связи со станцией"
                : connection === "stale"
                  ? "Данные не обновлялись больше минуты"
                  : active
                    ? "Данные обновляются"
                    : "Итоги сессии"}
            </strong>
            <p>
              {active && !connected
                ? "Показаны последние полученные значения. Состояние зарядки уточняется; мощность и время до завершения недоступны."
                : session.telemetry?.source === "demo" || apiMode === "mock"
                  ? "Демонстрация зарядки. Реальная станция не подключена."
                  : "Показания зарядной станции."}
            </p>
            {session.telemetry && (
              <small>
                Последнее обновление: {dateTime(session.telemetry.receivedAt)}
              </small>
            )}
          </div>
          <span
            className={`status status--${active ? "available" : "service"}`}
          >
            {active
              ? connected
                ? "Сессия активна"
                : "Последний статус: активна"
              : "Сессия завершена"}
          </span>
          <p>До желаемого уровня</p>
          <h2>
            {active && connected
              ? metrics.charge >= session.targetCharge
                ? "Желаемый уровень достигнут"
                : `Осталось примерно ${metrics.remaining} минут`
              : active
                ? "Ожидаем новые показания"
                : "Спасибо за поездку"}
          </h2>
          <div className="charge-heading">
            <strong>{metrics.charge}%</strong>
            <span>Цель {session.targetCharge}%</span>
          </div>
          <small>расчётный заряд батареи</small>
          <div className="charge-progress">
            <span style={{ width: `${metrics.charge}%` }} />
            <i style={{ left: `${session.targetCharge}%` }} />
          </div>
          <div className="scale">
            <span>0%</span>
            <span>100%</span>
          </div>
          <h3>Параметры зарядки</h3>
          <dl className="session-stats">
            <div>
              <dt>{metrics.energy.toFixed(1)} кВт⋅ч</dt>
              <dd>Получено</dd>
            </div>
            <div>
              <dt>{active && !connected ? "—" : `${session.power} кВт`}</dt>
              <dd>Мощность</dd>
            </div>
            <div>
              <dt>{money(metrics.amount)}</dt>
              <dd>Стоимость</dd>
            </div>
          </dl>
          <ErrorMessage message={action.error} />
          {active ? (
            <button
              className="button button--outline button--full"
              onClick={() => setStopOpen(true)}
            >
              Остановить зарядку
            </button>
          ) : (
            <ReceiptButton session={session} />
          )}
          <Link className="text-link" to="/driver/sessions">
            Все сессии →
          </Link>
          {apiMode === "mock" && active && (
            <details className="demo-controls">
              <summary>Проверить потерю связи · демо</summary>
              <p>
                Переключите состояние, чтобы проверить последние показания и
                восстановление связи.
              </p>
              <button
                className="button button--outline"
                disabled={action.busy}
                onClick={() =>
                  void action.run(() =>
                    mutate(() =>
                      api.simulateTelemetry(
                        session.id,
                        connected ? "offline" : "online",
                      ),
                    ),
                  )
                }
              >
                {connected ? "Имитировать потерю связи" : "Восстановить связь"}
              </button>
            </details>
          )}
        </section>
        <aside className="session-details">
          <h2>Детали сессии</h2>
          <span>Станция</span>
          <strong>{station.name}</strong>
          <small>{station.address}</small>
          <hr />
          <span>Параметры</span>
          <dl>
            <div>
              <dt>Разъём</dt>
              <dd>{session.connector}</dd>
            </div>
            <div>
              <dt>Тариф</dt>
              <dd>{session.tariff} ₽/кВт⋅ч</dd>
            </div>
            <div>
              <dt>Начало</dt>
              <dd>{dateTime(session.startedAt)}</dd>
            </div>
            <div>
              <dt>ID</dt>
              <dd>{session.id.slice(0, 8)}</dd>
            </div>
          </dl>
          <hr />
          <h3>Поддержка</h3>
          <p>Если возникла проблема, обратитесь к оператору станции.</p>
          <button className="button" onClick={() => setSupport(true)}>
            Связаться с поддержкой
          </button>
        </aside>
      </div>
      {stopOpen && (
        <Modal
          title="Завершить зарядку?"
          onClose={() => !action.busy && setStopOpen(false)}
        >
          <p>
            Получено {metrics.energy.toFixed(1)} кВт⋅ч. Стоимость{" "}
            {money(metrics.amount)}.
          </p>
          <ErrorMessage message={action.error} />
          <button
            className="button button--full"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await mutate(() => api.stop(session.id), "Зарядка завершена");
                setStopOpen(false);
              })
            }
          >
            {action.busy ? "Завершаем…" : "Подтвердить завершение"}
          </button>
        </Modal>
      )}
      {support && (
        <Modal title="Поддержка зарядки" onClose={() => setSupport(false)}>
          <p>
            Станция: {station.name}
            <br />
            ID сессии: {session.id.slice(0, 8)}
          </p>
          <p>
            Контакты оператора указаны на корпусе зарядной станции. Сохраните ID
            сессии для обращения.
          </p>
          <button
            className="button button--full"
            onClick={() => setSupport(false)}
          >
            Понятно
          </button>
        </Modal>
      )}
    </AppShell>
  );
}
