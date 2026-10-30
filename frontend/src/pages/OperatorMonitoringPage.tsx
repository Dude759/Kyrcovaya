import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { ErrorMessage } from "../components/Feedback";
import { api } from "../services/api";
import { errorMessage } from "../services/errors";
import { dateTime, downloadCsv, moneyPrecise } from "../utils/format";
import { useNow } from "../hooks/useNow";
import { sessionCsvRows, historyCsvRows } from "../utils/monitoring-csv";
import { serverSessionLabels } from "../utils/session-status";
import type {
  MonitoringSnapshot,
  MonitoringSession,
  MonitoringPage,
  PowerHistory,
  TechnicalEvent,
  MonitoringStation,
} from "../types/monitoring";

const watt = (v: number | null) =>
  v === null ? "Нет данных" : `${(v / 1000).toFixed(3)} кВт`;
const energy = (v: number | null) =>
  v === null ? "Нет данных" : `${(v / 1000).toFixed(3)} кВт⋅ч`;
const stamp = (v: string | null) => (v ? dateTime(v) : "Нет показаний");
const qualityLabels = {
  complete: "Полные данные",
  partial: "Неполные данные",
  missing: "Нет данных",
};
const connectionLabels = {
  fresh: "Свежие показания",
  stale: "Старше 60 секунд",
  missing: "Нет показаний",
  offline: "Связь с имитатором потеряна",
};
const showCost = (v: number | null) =>
  v === null ? "Расчёт не завершён" : moneyPrecise(v / 100);
function HistoryChart({ rows }: { rows: PowerHistory[] }) {
  const points = [...rows].sort(
    (a, b) =>
      a.intervalStart.localeCompare(b.intervalStart) ||
      a.stationId.localeCompare(b.stationId),
  );
  const max = Math.max(
    1,
    ...points.map((h) => h.averagePowerW ?? h.measuredSubsetAverageW ?? 0),
  );
  return (
    <div
      className="monitor-history-chart"
      role="img"
      aria-label="Почасовая нагрузка: отдельные столбцы, пропуски не соединяются"
    >
      {points.map((h) => {
        const value = h.averagePowerW ?? h.measuredSubsetAverageW;
        return (
          <div
            className={
              "monitor-history-point monitor-history-point--" + h.quality
            }
            key={h.stationId + h.intervalStart}
            title={`${h.stationName}, ${h.intervalStart}, ${qualityLabels[h.quality]}, ${watt(value)}`}
          >
            <span>{value === null ? "—" : (value / 1000).toFixed(1)}</span>
            <div className="monitor-history-track">
              {value !== null ? (
                <i style={{ height: `${Math.max(2, (value / max) * 100)}%` }} />
              ) : (
                <b>?</b>
              )}
            </div>
            <small>{new Date(h.intervalStart).getUTCHours()}:00 UTC</small>
            <small>{h.stationName}</small>
            <small>{qualityLabels[h.quality]}</small>
          </div>
        );
      })}
    </div>
  );
}
function StationReadings({
  s,
  stale,
}: {
  s: MonitoringStation;
  stale: boolean;
}) {
  return (
    <article className="record-card">
      <h3>{s.name}</h3>
      <dl className="details-list">
        <div>
          <dt>Измеренная мощность зарядок</dt>
          <dd>{watt(stale ? null : s.measuredPowerW)}</dd>
        </div>
        <div>
          <dt>Измеренный поднабор</dt>
          <dd>
            {watt(stale ? null : s.measuredSubsetPowerW)} · {s.measuredSessions}
            /{s.expectedSessions} сессий
          </dd>
        </div>
        <div>
          <dt>Выделено имитатору</dt>
          <dd>{watt(s.allocatedPowerW)}</dd>
        </div>
        <div>
          <dt>Локальный лимит станции</dt>
          <dd>{s.localLimitKw} кВт</dd>
        </div>
        <div>
          <dt>Последнее показание</dt>
          <dd>{stamp(s.lastMeasuredAt)}</dd>
        </div>
      </dl>
      <p>
        Источник: серверный имитатор.{" "}
        {s.complete && !stale
          ? "Текущие сессии измерены."
          : "Полная текущая нагрузка неизвестна."}
      </p>
      <Link
        className="button button--outline"
        to={"/operator/stations?station=" + s.id}
      >
        Настройки станции
      </Link>
    </article>
  );
}
export function StationTelemetry({ id }: { id: string }) {
  const [data, setData] = useState<MonitoringSnapshot | null>(null),
    [error, setError] = useState("");
  const now = useNow();
  useEffect(() => {
    let live = true,
      running = false;
    async function load() {
      if (running) return;
      running = true;
      try {
        const result = await api.operatorMonitoring(id);
        if (live) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (live) setError(errorMessage(e));
      } finally {
        running = false;
      }
    }
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id]);
  return (
    <section aria-label="Показания выбранной станции">
      <ErrorMessage message={error} />
      {data?.stations[0] ? (
        <StationReadings
          s={data.stations[0]}
          stale={
            now - Date.parse(data.asOf) > 60000 ||
            data.sessions.some(
              (x) =>
                x.currentPowerW !== null &&
                (x.ageSeconds ?? 0) * 1000 +
                  Math.max(0, now - Date.parse(data.asOf)) >
                  60000,
            )
          }
        />
      ) : (
        <p>Загружаем показания станции…</p>
      )}
    </section>
  );
}
export function OperatorMonitoringPage({
  view = "dashboard",
}: {
  view?: "dashboard" | "sessions" | "power";
}) {
  const [params] = useSearchParams();
  const [stationId, setStation] = useState(params.get("station") ?? ""),
    [status, setStatus] = useState(""),
    [quality, setQuality] = useState(""),
    [days, setDays] = useState("1");
  const [historyCursor, setHistoryCursor] = useState<string | null>(null),
    [sessionCursor, setSessionCursor] = useState<string | null>(null),
    [eventCursor, setEventCursor] = useState<string | null>(null);
  const [revision, setRevision] = useState(0),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [state, setState] = useState<{
    snapshot: MonitoringSnapshot;
    history: MonitoringPage<PowerHistory>;
    sessions: MonitoringPage<MonitoringSession>;
    events: MonitoringPage<TechnicalEvent>;
    receivedAt: number;
  } | null>(null);
  const now = useNow();
  useEffect(() => {
    let live = true,
      running = false;
    const from = new Date(
      Math.floor(Date.now() / 3600000) * 3600000 - Number(days) * 86400000,
    ).toISOString();
    const base: Record<string, string> = stationId ? { stationId } : {};
    async function load() {
      if (running) return;
      running = true;
      const receivedAt = Date.now();
      try {
        const [snapshot, history, sessions, events] = await Promise.all([
          api.operatorMonitoring(),
          api.operatorHistory(
            new URLSearchParams({
              ...base,
              from,
              limit: "24",
              ...(quality ? { quality } : {}),
              ...(historyCursor ? { cursor: historyCursor } : {}),
            }).toString(),
          ),
          api.operatorSessions(
            new URLSearchParams({
              ...base,
              limit: "30",
              ...(status ? { status } : {}),
              ...(sessionCursor ? { cursor: sessionCursor } : {}),
            }).toString(),
          ),
          api.operatorTechnicalEvents(
            new URLSearchParams({
              ...base,
              limit: "10",
              ...(eventCursor ? { cursor: eventCursor } : {}),
            }).toString(),
          ),
        ]);
        if (live) {
          setState({ snapshot, history, sessions, events, receivedAt });
          setError("");
        }
      } catch (e) {
        if (live) setError(errorMessage(e));
      } finally {
        if (live) setLoading(false);
        running = false;
      }
    }
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [
    stationId,
    status,
    quality,
    days,
    historyCursor,
    sessionCursor,
    eventCursor,
    revision,
  ]);
  const s = state?.snapshot;
  const elapsed = state ? Math.max(0, now - state.receivedAt) : 0;
  const stale =
    !!s &&
    (now - Date.parse(s.asOf) > 60000 ||
      s.sessions.some(
        (x) =>
          x.currentPowerW !== null &&
          (x.ageSeconds ?? 0) * 1000 + elapsed > 60000,
      ));
  const sessions =
    state?.sessions.items.map((x) =>
      x.telemetry === "fresh" && (x.ageSeconds ?? 0) * 1000 + elapsed > 60000
        ? { ...x, currentPowerW: null, telemetry: "stale" as const }
        : x,
    ) ?? [];
  const reset = () => {
    setHistoryCursor(null);
    setSessionCursor(null);
    setEventCursor(null);
  };
  return (
    <AppShell
      role="operator"
      active={
        view === "sessions"
          ? "sessions"
          : view === "power"
            ? "power"
            : "analytics"
      }
      title={
        view === "sessions"
          ? "Зарядные сессии"
          : view === "power"
            ? "Станции и мощность"
            : "Панель оператора"
      }
      subtitle="Измерения PostgreSQL · серверный имитатор"
    >
      <p className="demo-note">
        Учебный мониторинг. Физическое оборудование и энергосистема не
        подключены. Сетевой бюджет и резерв неизвестны.
      </p>
      <div className="page-toolbar">
        <p role="status">
          {loading
            ? "Загружаем показатели…"
            : `Снимок сервера: ${stamp(s?.asOf ?? null)} · обновление каждые 10 секунд`}
        </p>
        <button
          className="button button--outline"
          onClick={() => setRevision((v) => v + 1)}
        >
          Обновить показатели
        </button>
      </div>
      <ErrorMessage message={error} />
      {stale && (
        <p role="alert">
          Показания устарели. Текущая мощность скрыта до обновления;
          историческая энергия сохранена.
        </p>
      )}
      {s && (
        <>
          <section className="operator-kpis">
            <article>
              <span>Измеренная мощность текущих зарядок</span>
              <strong>{watt(stale ? null : s.measuredPowerW)}</strong>
              <small>
                {s.complete && !stale
                  ? "Все незавершённые сессии измерены"
                  : "Полная текущая нагрузка неизвестна"}
              </small>
            </article>
            <article>
              <span>Измеренный поднабор</span>
              <strong>{watt(stale ? null : s.measuredSubsetPowerW)}</strong>
              <small>
                {s.measuredSessions} из {s.expectedSessions} незавершённых
                сессий · simulator
              </small>
            </article>
            <article>
              <span>Выделено имитатору</span>
              <strong>{watt(s.allocatedPowerW)}</strong>
              <small>Локальное выделение, не измеренная нагрузка</small>
            </article>
            <article>
              <span>Стоимость завершённых тестовых зарядок</span>
              <strong>{moneyPrecise(s.completedTestCostKopecks / 100)}</strong>
              <small>
                Сохранённые расчёты session_settlements · не кассовый отчёт
              </small>
            </article>
          </section>
          <section className="record-card">
            <h2>Состояния сессий организации</h2>
            <div className="monitor-counts">
              {Object.entries(s.sessionCounts).map(([k, v]) => (
                <button
                  className="button button--outline"
                  key={k}
                  onClick={() => {
                    setStatus(k);
                    setSessionCursor(null);
                  }}
                >
                  {serverSessionLabels[k as MonitoringSession["status"]]}: {v}
                </button>
              ))}
            </div>
            <p>
              Известная накопленная энергия: {energy(s.knownEnergyWh)}. Энергия
              за периоды отсутствия связи не достраивается.
            </p>
            <p>
              Свежие: {s.telemetryCounts.fresh} · устаревшие:{" "}
              {s.telemetryCounts.stale} · без показаний:{" "}
              {s.telemetryCounts.missing} · потеря связи с имитатором:{" "}
              {s.telemetryCounts.offline}
            </p>
          </section>
          <section
            className="monitor-filters"
            aria-label="Фильтры истории и сессий"
          >
            <label className="field">
              <span>Станция</span>
              <select
                value={stationId}
                onChange={(e) => {
                  setStation(e.target.value);
                  reset();
                }}
              >
                <option value="">Все станции организации</option>
                {s.stations.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Статус сессии</span>
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setSessionCursor(null);
                }}
              >
                <option value="">Все состояния</option>
                {Object.keys(s.sessionCounts).map((k) => (
                  <option key={k} value={k}>
                    {serverSessionLabels[k as MonitoringSession["status"]]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Период истории</span>
              <select
                value={days}
                onChange={(e) => {
                  setDays(e.target.value);
                  setHistoryCursor(null);
                }}
              >
                <option value="1">Последние 24 часа</option>
                <option value="7">Последние 7 дней</option>
                <option value="30">Последние 30 дней</option>
              </select>
            </label>
            <label className="field">
              <span>Качество истории</span>
              <select
                value={quality}
                onChange={(e) => {
                  setQuality(e.target.value);
                  setHistoryCursor(null);
                }}
              >
                <option value="">Все интервалы</option>
                {Object.entries(qualityLabels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </section>
          {view !== "sessions" && (
            <div className="record-grid">
              {s.stations
                .filter((x) => !stationId || x.id === stationId)
                .map((x) => (
                  <StationReadings key={x.id} s={x} stale={stale} />
                ))}
            </div>
          )}
          <section className="record-card">
            <div className="page-toolbar">
              <h2>Сессии · текущая страница</h2>
              <button
                className="button button--outline"
                onClick={() =>
                  downloadCsv(
                    "simulator-sessions.csv",
                    sessionCsvRows(sessions),
                  )
                }
              >
                CSV сессий этой страницы
              </button>
            </div>
            {!sessions.length && <p>Сессий по выбранным условиям нет.</p>}
            <div className="monitor-session-grid">
              {sessions.map((x) => (
                <article className="monitor-session" key={x.id}>
                  <h3>
                    {x.stationName} · {x.connectorLabel}
                  </h3>
                  <p>
                    #{x.id.slice(0, 8)} · {x.connectorType} ·{" "}
                    {serverSessionLabels[x.status]}
                  </p>
                  <dl className="details-list">
                    <div>
                      <dt>Измерено сейчас</dt>
                      <dd>{watt(x.currentPowerW)}</dd>
                    </div>
                    <div>
                      <dt>Выделено имитатору</dt>
                      <dd>{watt(x.allocatedPowerW)}</dd>
                    </div>
                    <div>
                      <dt>Полученная энергия</dt>
                      <dd>{energy(x.knownEnergyWh)}</dd>
                    </div>
                    <div>
                      <dt>Последнее показание</dt>
                      <dd>{stamp(x.lastMeasuredAt)}</dd>
                    </div>
                    <div>
                      <dt>Телеметрия simulator</dt>
                      <dd>{connectionLabels[x.telemetry]}</dd>
                    </div>
                    <div>
                      <dt>Запуск подтверждён</dt>
                      <dd>{stamp(x.startedAt)}</dd>
                    </div>
                    <div>
                      <dt>Завершение подтверждено</dt>
                      <dd>
                        {x.endedAt ? stamp(x.endedAt) : "Не подтверждено"}
                      </dd>
                    </div>
                    <div>
                      <dt>Окончательная стоимость тестовой зарядки</dt>
                      <dd>{showCost(x.finalCostKopecks)}</dd>
                    </div>
                  </dl>
                  {x.telemetryGap && (
                    <p>
                      В измерениях есть разрыв; энергия за простой не начислена.
                    </p>
                  )}
                </article>
              ))}
            </div>
            <div className="form-actions">
              <button
                className="button button--outline"
                disabled={!sessionCursor}
                onClick={() => setSessionCursor(null)}
              >
                Первые сессии
              </button>
              <button
                className="button"
                disabled={!state?.sessions.nextCursor}
                onClick={() => setSessionCursor(state!.sessions.nextCursor)}
              >
                Следующие сессии
              </button>
            </div>
          </section>
          <section className="record-card">
            <div className="page-toolbar">
              <h2>Почасовая история нагрузки</h2>
              <button
                className="button button--outline"
                onClick={() =>
                  downloadCsv(
                    "simulator-hourly-history.csv",
                    historyCsvRows(state!.history.items),
                  )
                }
              >
                CSV истории этой страницы
              </button>
            </div>
            <p>
              Источник: серверный имитатор. Часы UTC. Полные данные — сплошной
              столбец; неполный измеренный поднабор — штриховка; пропуск — «?».
              Пропуски не соединяются и не считаются нулём. Средняя полной
              нагрузки известна только при полном покрытии часа.
            </p>
            {!state?.history.items.length ? (
              <p>
                Агрегатов пока нет. Обработка исходных показаний выполняется раз
                в минуту.
              </p>
            ) : (
              <>
                <HistoryChart rows={state.history.items} />
                <div className="table-scroll">
                  <table className="monitor-history-table">
                    <thead>
                      <tr>
                        <th>Станция / час UTC</th>
                        <th>Качество</th>
                        <th>Измерено, Вт⋅ч</th>
                        <th>Средняя полная, Вт</th>
                        <th>Средняя поднабора, Вт</th>
                        <th>Покрытие, с</th>
                        <th>Разрывы / границы</th>
                        <th>Без привязки к часу, Вт⋅ч</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.history.items.map((h) => (
                        <tr key={h.stationId + h.intervalStart}>
                          <td>
                            {h.stationName}
                            <br />
                            {h.intervalStart}
                          </td>
                          <td>{qualityLabels[h.quality]}</td>
                          <td>{h.measuredEnergyWh ?? "—"}</td>
                          <td>{h.averagePowerW ?? "—"}</td>
                          <td>{h.measuredSubsetAverageW ?? "—"}</td>
                          <td>{(h.observedMs / 1000).toFixed(1)}</td>
                          <td>
                            {h.gapCount} / {h.boundaryCount}
                          </td>
                          <td>{h.unattributedEnergyWh}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div className="form-actions">
              <button
                className="button button--outline"
                disabled={!historyCursor}
                onClick={() => setHistoryCursor(null)}
              >
                Первые интервалы
              </button>
              <button
                className="button"
                disabled={!state?.history.nextCursor}
                onClick={() => setHistoryCursor(state!.history.nextCursor)}
              >
                Следующие интервалы
              </button>
            </div>
          </section>
          <section className="record-card">
            <h2>Состояния команд и разрывы измерений</h2>
            <p>
              Технические данные имитатора; отдельно от неизменяемого аудита
              действий оператора.
            </p>
            {state?.events.items.map((e) => (
              <p key={e.id}>
                {stamp(e.at)} · {e.stationId} ·{" "}
                {e.kind === "measurement_gap"
                  ? "Разрыв показаний"
                  : e.kind === "start"
                    ? "Команда запуска"
                    : "Команда остановки"}{" "}
                ·{" "}
                {e.status === "acknowledged"
                  ? "Подтверждена"
                  : e.status === "pending"
                    ? "Ожидает отправки"
                    : e.status === "submitted"
                      ? "Ожидает подтверждения"
                      : e.status === "rejected"
                        ? "Отклонена"
                        : "Зафиксирован"}
              </p>
            ))}
            {!state?.events.items.length && (
              <p>Технических событий пока нет.</p>
            )}
            <div className="form-actions">
              <button
                className="button button--outline"
                disabled={!eventCursor}
                onClick={() => setEventCursor(null)}
              >
                Первые события
              </button>
              <button
                className="button"
                disabled={!state?.events.nextCursor}
                onClick={() => setEventCursor(state!.events.nextCursor)}
              >
                Следующие события
              </button>
            </div>
            <Link to="/operator/stations">Журнал действий оператора →</Link>
          </section>
        </>
      )}
    </AppShell>
  );
}
