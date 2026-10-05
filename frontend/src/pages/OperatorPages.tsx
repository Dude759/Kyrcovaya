import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import { AppShell } from "../components/AppShell";
import { EmptyState, ErrorMessage } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { useAction } from "../hooks/useAction";
import { useNow } from "../hooks/useNow";
import { api } from "../services/api";
import { useApp } from "../state/context";
import { statusLabels } from "../data";
import {
  dateTime,
  downloadCsv,
  money,
  displaySessionMetrics as sessionMetrics,
} from "../utils/format";
import { ForecastPanel } from "../components/ForecastPanel";
import type { Session } from "../types/domain";

export function OperatorDashboardPage() {
  const { data } = useApp();
  const { stations, sessions, networkLimit, events } = data!;
  const online = stations.filter(
    (s) => !["offline", "service"].includes(s.status),
  ).length;
  const active = sessions.filter((s) => s.status === "active");
  const load = stations.reduce(
    (sum, s) =>
      sum +
      (["offline", "service"].includes(s.status)
        ? 0
        : (s.limitKw * (s.loadPercent ?? 0)) / 100),
    0,
  );
  const revenue = sessions
    .filter((s) => s.status === "completed")
    .reduce((sum, s) => sum + s.energy * s.tariff, 0);
  return (
    <AppShell
      role="operator"
      active="analytics"
      title="Панель оператора"
      subtitle="Мониторинг зарядной сети"
    >
      <section className="operator-kpis">
        {[
          [
            "Станций онлайн",
            `${online} / ${stations.length}`,
            "В текущей сети",
          ],
          ["Активных сессий", `${active.length}`, "В личных кабинетах"],
          [
            "Текущая нагрузка",
            `${(load / 1000).toFixed(2)} МВт`,
            `${Math.round((load / networkLimit) * 100)}% общего лимита`,
          ],
          ["Выручка", money(revenue), "Завершённые сессии"],
        ].map(([title, value, note]) => (
          <article key={title}>
            <span>{title}</span>
            <strong>{value}</strong>
            <small className="good">{note}</small>
          </article>
        ))}
      </section>
      <ForecastPanel
        forecast={data!.forecast ?? null}
        networkLimit={networkLimit}
      />
      <div className="dashboard-grid">
        <section className="dashboard-panel network-panel">
          <h2>Загрузка станций</h2>
          {stations
            .filter((s) => s.loadPercent !== null)
            .map((s) => (
              <div className="district-row" key={s.id}>
                <Link to={`/operator/stations?station=${s.id}`}>{s.name}</Link>
                <strong>
                  {["offline", "service"].includes(s.status)
                    ? "—"
                    : `${s.loadPercent}%`}
                </strong>
                <i>
                  <b
                    style={{
                      width: `${["offline", "service"].includes(s.status) ? 0 : s.loadPercent}%`,
                    }}
                  />
                </i>
              </div>
            ))}
        </section>
        <section className="dashboard-panel">
          <h2>Мощность сети</h2>
          <strong className="power-value">
            {(networkLimit / 1000).toFixed(1)} МВт
          </strong>
          <p>Общий выделенный лимит</p>
          <dl className="details-list">
            <div>
              <dt>Сумма лимитов станций</dt>
              <dd>{stations.reduce((sum, s) => sum + s.limitKw, 0)} кВт</dd>
            </div>
            <div>
              <dt>Резерв</dt>
              <dd>{Math.round(networkLimit - load)} кВт</dd>
            </div>
          </dl>
          <Link className="button" to="/operator/power">
            Управлять мощностью
          </Link>
        </section>
      </div>
      <section className="alerts-panel">
        <div className="page-toolbar">
          <h2>Журнал событий</h2>
          <button
            className="button button--outline"
            onClick={() =>
              downloadCsv("network-events.csv", [
                ["Дата", "Станция", "Событие"],
                ...events.map((e) => [
                  dateTime(e.date),
                  stations.find((s) => s.id === e.stationId)?.name ?? "Сеть",
                  e.message,
                ]),
              ])
            }
          >
            Экспорт CSV
          </button>
        </div>
        <div className="alert-head">
          <span>Дата</span>
          <span>Событие</span>
          <span>Объект</span>
        </div>
        {events.slice(0, 20).map((e) => (
          <div className={`alert-row alert-row--${e.severity}`} key={e.id}>
            <strong>{dateTime(e.date)}</strong>
            <span>{e.message}</span>
            {e.stationId ? (
              <Link to={`/operator/stations?station=${e.stationId}`}>
                {stations.find((s) => s.id === e.stationId)?.name} →
              </Link>
            ) : (
              <span>Вся сеть</span>
            )}
          </div>
        ))}
      </section>
    </AppShell>
  );
}

export function OperatorStationsPage() {
  const { data, mutate } = useApp();
  const [params] = useSearchParams();
  const stations = data!.stations;
  const [selectedId, setSelected] = useState(
    params.get("station") ?? stations[0]?.id,
  );
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [district, setDistrict] = useState("all");
  const station = stations.find((s) => s.id === selectedId) ?? stations[0];
  const [draftLimit, setDraft] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<
    "limit" | "service" | "diagnostics" | null
  >(null);
  const action = useAction();
  const limit = draftLimit ?? station.limitKw;
  const visible = stations.filter(
    (s) =>
      `${s.name} ${s.address}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()) &&
      (status === "all" || status === s.status) &&
      (district === "all" || district === s.district),
  );
  const activeCount = data!.sessions.filter(
    (s) => s.stationId === station.id && s.status === "active",
  ).length;
  async function apply() {
    await action.run(async () => {
      await mutate(
        () =>
          api.station(
            station.id,
            confirm === "limit"
              ? { limitKw: limit }
              : { service: station.status !== "service" },
          ),
        confirm === "limit" ? "Лимит сохранён" : "Режим станции изменён",
      );
      setDraft(null);
      setConfirm(null);
    });
  }
  return (
    <AppShell
      role="operator"
      active="stations"
      title="Станции и мощность"
      subtitle="Управление состоянием и лимитами объектов"
    >
      <div className="page-toolbar">
        <label className="search-field">
          <Search size={17} />
          <input
            aria-label="Поиск объектов"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Адрес или станция"
          />
        </label>
        <div className="filters">
          <select
            aria-label="Статус станции"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">Все статусы</option>
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Район"
            value={district}
            onChange={(e) => setDistrict(e.target.value)}
          >
            <option value="all">Все районы</option>
            {stations.map((s) => (
              <option key={s.id}>{s.district}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="operator-stations-layout">
        <section className="stations-table-panel">
          <div className="panel-heading">
            <h2>Объекты сети · {visible.length}</h2>
            <button
              className="button button--outline"
              onClick={() =>
                downloadCsv("stations.csv", [
                  ["Станция", "Адрес", "Статус", "Нагрузка,%", "Лимит,кВт"],
                  ...visible.map((s) => [
                    s.name,
                    s.address,
                    statusLabels[s.status],
                    s.loadPercent ?? "",
                    s.limitKw,
                  ]),
                ])
              }
            >
              Экспорт
            </button>
          </div>
          <div className="table-scroll">
            <div className="stations-table stations-table--head">
              <span>Станция</span>
              <span>Статус</span>
              <span>Нагрузка</span>
              <span>Лимит</span>
              <span />
            </div>
            {visible.map((s) => (
              <button
                className={`stations-table ${s.id === station.id ? "is-selected" : ""}`}
                key={s.id}
                onClick={() => {
                  setSelected(s.id);
                  setDraft(null);
                  action.setError("");
                }}
              >
                <span>
                  <strong>{s.name}</strong>
                  <small>{s.address}</small>
                </span>
                <span>
                  <i className={`status status--${s.status}`}>
                    {statusLabels[s.status]}
                  </i>
                </span>
                <span className={`load-number load-number--${s.status}`}>
                  {s.loadPercent ?? "—"}
                  {s.loadPercent !== null && "%"}
                  <i>
                    <b style={{ width: `${s.loadPercent ?? 0}%` }} />
                  </i>
                </span>
                <span>{s.limitKw} кВт</span>
                <span>Настроить</span>
              </button>
            ))}
          </div>
          {!visible.length && <EmptyState title="Объекты не найдены" />}
        </section>
        <aside className="power-control">
          <span className={`status status--${station.status}`}>
            {statusLabels[station.status]}
          </span>
          <h2>{station.name}</h2>
          <p>{station.address}</p>
          <hr />
          <h3>Выделенная мощность</h3>
          <strong className="power-value">{limit} кВт</strong>
          <small>из доступных 600 кВт</small>
          <input
            className="power-range"
            aria-label="Лимит мощности станции"
            type="range"
            min={120}
            max={600}
            step={20}
            value={limit}
            onChange={(e) => setDraft(Number(e.target.value))}
          />
          <div className="range-labels">
            <span>120 кВт</span>
            <span>600 кВт</span>
          </div>
          <hr />
          <h3>Разъёмы</h3>
          <dl className="details-list">
            {station.connectors.map((c) => (
              <div key={c.type}>
                <dt>{c.type}</dt>
                <dd>
                  {c.total - c.available} из {c.total} занято
                </dd>
              </div>
            ))}
          </dl>
          <ErrorMessage message={action.error} />
          <div className="stack-actions">
            <button
              className="button button--full"
              disabled={limit === station.limitKw || action.busy}
              onClick={() => setConfirm("limit")}
            >
              Сохранить лимит
            </button>
            <button
              className="button button--outline button--full"
              onClick={() => setConfirm("diagnostics")}
            >
              Диагностика
            </button>
            <button
              className="button button--outline button--full"
              disabled={!!activeCount && station.status !== "service"}
              onClick={() => setConfirm("service")}
            >
              {station.status === "service"
                ? "Вывести из сервиса"
                : "Перевести в сервис"}
            </button>
          </div>
          {!!activeCount && (
            <p className="power-note">
              Активных сессий: {activeCount}. Для сервисного режима сначала
              завершите зарядки.
            </p>
          )}
        </aside>
      </div>
      {confirm && (
        <Modal
          title={
            confirm === "limit"
              ? "Применить новый лимит?"
              : confirm === "service"
                ? "Изменить режим станции?"
                : "Диагностика станции"
          }
          onClose={() => !action.busy && setConfirm(null)}
        >
          {confirm === "diagnostics" ? (
            <>
              <p>
                {station.name} · {statusLabels[station.status]}
              </p>
              <dl className="details-list">
                <div>
                  <dt>Телеметрия</dt>
                  <dd>
                    {station.status === "offline" ? "Нет связи" : "Получена"}
                  </dd>
                </div>
                <div>
                  <dt>Мощность</dt>
                  <dd>{station.limitKw} кВт</dd>
                </div>
                <div>
                  <dt>Активные зарядки</dt>
                  <dd>{activeCount}</dd>
                </div>
              </dl>
              <p>
                {station.status === "offline"
                  ? "Проверьте питание контроллера и сетевое подключение на объекте."
                  : "Параметры станции доступны. Изменения режима фиксируются в журнале событий."}
              </p>
            </>
          ) : (
            <>
              <p>
                {station.name}:{" "}
                {confirm === "limit"
                  ? `${station.limitKw} → ${limit} кВт`
                  : station.status === "service"
                    ? "выход из сервисного режима"
                    : "сервисный режим, новые брони будут недоступны"}
                .
              </p>
              <ErrorMessage message={action.error} />
              <button
                className="button button--full"
                disabled={action.busy}
                onClick={() => void apply()}
              >
                {action.busy ? "Применяем…" : "Подтвердить"}
              </button>
            </>
          )}
        </Modal>
      )}
    </AppShell>
  );
}
export function OperatorPowerPage() {
  const { data, mutate } = useApp();
  const [draft, setDraft] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const action = useAction();
  const limit = draft ?? data!.networkLimit;
  const allocated = data!.stations.reduce((sum, s) => sum + s.limitKw, 0);
  return (
    <AppShell
      role="operator"
      active="power"
      title="Управление мощностью"
      subtitle="Лимиты сети и распределение нагрузки"
    >
      <div className="power-page">
        <section className="network-limit-panel">
          <span className="section-label">Общий лимит сети</span>
          <div className="limit-heading">
            <div>
              <strong>{(limit / 1000).toFixed(1)} МВт</strong>
              <small>Станциям выделено {allocated} кВт</small>
            </div>
            <span
              className={`status status--${limit >= allocated ? "available" : "offline"}`}
            >
              Резерв {limit - allocated} кВт
            </span>
          </div>
          <input
            className="power-range"
            type="range"
            min={2000}
            max={8000}
            step={100}
            value={limit}
            aria-label="Общий лимит сети"
            onChange={(e) => setDraft(Number(e.target.value))}
          />
          <div className="range-labels">
            <span>2,0 МВт</span>
            <span>8,0 МВт</span>
          </div>
          <ErrorMessage
            message={
              limit < allocated
                ? "Лимит не может быть меньше суммарной мощности станций."
                : action.error
            }
          />
          <div className="form-actions">
            <button
              className="button"
              disabled={limit < allocated || limit === data!.networkLimit}
              onClick={() => setConfirm(true)}
            >
              Применить лимит
            </button>
          </div>
        </section>
        <section className="allocation-panel">
          <div className="panel-title">
            <div>
              <span className="section-label">Распределение</span>
              <h2>Объекты сети</h2>
            </div>
          </div>
          {data!.stations.map((s) => (
            <div className="allocation-row" key={s.id}>
              <span>
                <strong>{s.name}</strong>
                <small>{s.limitKw} кВт выделено</small>
              </span>
              <i>
                <b style={{ width: `${(s.limitKw / limit) * 100}%` }} />
              </i>
              <strong>{Math.round((s.limitKw / limit) * 100)}%</strong>
            </div>
          ))}
        </section>
        <section className="forecast-note">
          <span>Резерв мощности</span>
          <strong>
            {limit - allocated >= 900
              ? "Сеть имеет достаточный резерв"
              : "Рекомендуется увеличить резерв сети"}
          </strong>
          <p>
            Резерв для пикового спроса: {limit - allocated} кВт. Изменения
            лимитов фиксируются в журнале событий.
          </p>
        </section>
      </div>
      {confirm && (
        <Modal
          title="Изменить общий лимит?"
          onClose={() => !action.busy && setConfirm(false)}
        >
          <p>
            Новый лимит: {limit} кВт. Выделено станциям: {allocated} кВт.
          </p>
          <ErrorMessage message={action.error} />
          <button
            className="button button--full"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await mutate(() => api.network(limit), "Общий лимит сохранён");
                setDraft(null);
                setConfirm(false);
              })
            }
          >
            {action.busy ? "Применяем…" : "Подтвердить"}
          </button>
        </Modal>
      )}
    </AppShell>
  );
}
export function OperatorSessionsPage() {
  const { data, mutate } = useApp();
  const now = useNow();
  const metrics = (s: Session) => sessionMetrics(s, s.batteryCapacity, now);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active");
  const [detail, setDetail] = useState<Session | null>(null);
  const action = useAction();
  const sessions = data!.sessions.filter(
    (s) =>
      (status === "all" || s.status === status) &&
      `${s.id} ${data!.stations.find((station) => station.id === s.stationId)?.name} ${s.userId}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const current = detail
    ? data!.sessions.find((s) => s.id === detail.id)
    : null;
  return (
    <AppShell
      role="operator"
      active="sessions"
      title="Зарядные сессии"
      subtitle="Контроль зарядок и история завершений"
    >
      <div className="page-toolbar">
        <label className="search-field">
          <Search size={17} />
          <input
            aria-label="Поиск сессий"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Станция или ID"
          />
        </label>
        <div className="filters">
          <select
            aria-label="Статус сессии"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="active">Активные</option>
            <option value="completed">Завершённые</option>
            <option value="all">Все</option>
          </select>
          <button
            onClick={() =>
              downloadCsv("sessions.csv", [
                [
                  "ID",
                  "Станция",
                  "Разъём",
                  "Начало",
                  "Энергия,кВт⋅ч",
                  "Статус",
                ],
                ...sessions.map((s) => [
                  s.id,
                  data!.stations.find((station) => station.id === s.stationId)
                    ?.name ?? "",
                  s.connector,
                  dateTime(s.startedAt),
                  metrics(s).energy,
                  s.status,
                ]),
              ])
            }
          >
            Экспорт CSV
          </button>
        </div>
      </div>
      <section className="sessions-panel">
        <div className="panel-heading">
          <h2>Сессии · {sessions.length}</h2>
        </div>
        <div className="table-scroll">
          <div className="session-table session-table--head">
            <span>ID и станция</span>
            <span>Аккаунт</span>
            <span>Разъём</span>
            <span>Начало</span>
            <span>Мощность</span>
            <span>Получено</span>
            <span>Статус</span>
          </div>
          {sessions.map((s) => (
            <button
              className="session-table session-table--button"
              key={s.id}
              onClick={() => {
                setDetail(s);
                action.setError("");
              }}
            >
              <span>
                <strong>#{s.id.slice(0, 8)}</strong>
                <small>
                  {
                    data!.stations.find((station) => station.id === s.stationId)
                      ?.name
                  }
                </small>
              </span>
              <span>{s.userId.slice(0, 8)}</span>
              <span>{s.connector}</span>
              <span>{dateTime(s.startedAt)}</span>
              <strong>{s.power} кВт</strong>
              <span>{metrics(s).energy.toFixed(1)} кВт⋅ч</span>
              <i
                className={`status status--${s.status === "active" ? "available" : "service"}`}
              >
                {s.status === "active" ? "Заряжается" : "Завершена"}
              </i>
            </button>
          ))}
        </div>
        {!sessions.length && (
          <EmptyState
            title="Сессий не найдено"
            text="Попробуйте другой статус или начните зарядку в кабинете водителя."
          />
        )}
      </section>
      {current && (
        <Modal
          title={`Сессия #${current.id.slice(0, 8)}`}
          onClose={() => !action.busy && setDetail(null)}
        >
          <p>{data!.stations.find((s) => s.id === current.stationId)?.name}</p>
          <dl className="details-list">
            <div>
              <dt>Разъём</dt>
              <dd>{current.connector}</dd>
            </div>
            <div>
              <dt>Начало</dt>
              <dd>{dateTime(current.startedAt)}</dd>
            </div>
            <div>
              <dt>Энергия</dt>
              <dd>{metrics(current).energy.toFixed(1)} кВт⋅ч</dd>
            </div>
            <div>
              <dt>Стоимость</dt>
              <dd>{money(metrics(current).amount)}</dd>
            </div>
          </dl>
          <ErrorMessage message={action.error} />
          {current.status === "active" && (
            <button
              className="button button--full"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await mutate(
                    () => api.stop(current.id),
                    "Зарядная сессия завершена оператором",
                  );
                  setDetail(null);
                })
              }
            >
              {action.busy ? "Завершаем…" : "Завершить сессию"}
            </button>
          )}
        </Modal>
      )}
    </AppShell>
  );
}
