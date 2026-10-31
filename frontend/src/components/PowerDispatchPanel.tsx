import { useEffect, useRef, useState } from "react";
import { api } from "../services/api";
import { ErrorMessage } from "./Feedback";
import { errorMessage } from "../services/errors";
import { dateTime } from "../utils/format";
import { useNow } from "../hooks/useNow";
export type DispatchView = {
  enabled: boolean;
  source: string;
  status: string;
  withinBudget: boolean | null;
  acknowledgedW: number;
  grid: {
    budgetW: number | null;
    validity: string;
    asOf: string;
    freshnessSeconds: number;
    reading: { receivedAt: string | null };
  };
  sessions: {
    id: string;
    stationId: string;
    status: string;
    requestedW: number;
    plannedW: number | null;
    acknowledgedW: number;
    measuredW: number | null;
    effectiveAt: string | null;
    managed: boolean;
    reconciliation: string;
    command: null | {
      id: string;
      targetW: number;
      status: string;
      confirmedAt: string | null;
      reason: string | null;
    };
  }[];
  history: {
    id: string;
    created_at: string;
    budget_w: string | null;
    planned_w: string;
    acknowledged_w?: string | null;
  }[];
};
const watt = (v: number | null) =>
  v === null ? "Нет достоверных данных" : `${(v / 1000).toFixed(3)} кВт`;
const labels: Record<string, string> = {
  off: "Выключено",
  pending: "Ожидает подтверждения",
  submitted: "Отправлена устройству",
  acknowledged: "Подтверждено имитатором",
  rejected: "Отказ устройства / устаревшая команда",
  degraded: "Требуется сверка мощности",
};
export function PowerDispatchPanel() {
  const [data, setData] = useState<DispatchView | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID()),
    now = useNow();
  async function refresh() {
    setData(await api.powerDispatch());
    setError("");
  }
  useEffect(() => {
    let live = true,
      running = false;
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const d = await api.powerDispatch();
        if (live) {
          setData(d);
          setError("");
        }
      } catch (e) {
        if (live) setError(errorMessage(e));
      } finally {
        running = false;
      }
    };
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  const stale =
    !!data?.grid.reading.receivedAt &&
    now - Date.parse(data.grid.reading.receivedAt) >
      data.grid.freshnessSeconds * 1000;
  const disconnected = !!data && now - Date.parse(data.grid.asOf) > 15000;
  const unknown = stale || disconnected || data?.grid.budgetW === null;
  async function toggle() {
    if (!data) return;
    setBusy(true);
    try {
      setData(await api.setPowerDispatch(!data.enabled, key.current));
      key.current = crypto.randomUUID();
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const max = Math.max(
    1,
    ...(data?.history ?? []).flatMap((h) => [
      Number(h.budget_w ?? 0),
      Number(h.planned_w),
      Number(h.acknowledged_w ?? 0),
    ]),
  );
  return (
    <section
      className="record-card dispatch-panel"
      aria-label="Применение мощности"
    >
      <div className="dispatch-heading">
        <div>
          <span className="eyebrow">УЧЕБНЫЕ УСТРОЙСТВА · LIVE</span>
          <h2>Применение мощности</h2>
          <p>
            Команда меняет зарядку только после квитанции имитатора. Реальной
            связи с энергокомпанией нет.
          </p>
        </div>
        <span
          className={`dispatch-status ${data?.status === "degraded" || unknown ? "dispatch-status--alert" : ""}`}
          role="status"
        >
          {disconnected
            ? "Нет свежего ответа API"
            : labels[data?.status ?? "pending"]}
        </span>
      </div>
      {error && <ErrorMessage message={error} />}
      <div className="dispatch-controls">
        <button
          className="button button--secondary"
          onClick={() => void refresh().catch((e) => setError(errorMessage(e)))}
          disabled={busy}
        >
          Обновить применение
        </button>
        <button
          className="button"
          onClick={() => void toggle()}
          disabled={
            busy ||
            !data ||
            data.sessions.length > 0 ||
            (!data.enabled && unknown)
          }
        >
          {data?.enabled
            ? "Выключить управление"
            : "Включить управление имитаторами"}
        </button>
      </div>
      <p className="muted">
        Переключение разрешено после завершения всех зарядок и сверки команд
        организации. Текущие зарядки не переводятся в другой режим.
      </p>
      {data && (
        <>
          <dl className="details-list">
            <div>
              <dt>Бюджет учебной сети</dt>
              <dd>{unknown ? watt(null) : watt(data.grid.budgetW)}</dd>
            </div>
            <div>
              <dt>Последняя подтверждённая мощность</dt>
              <dd>{watt(data.acknowledgedW)}</dd>
            </div>
            <div>
              <dt>Соблюдение текущего бюджета</dt>
              <dd>
                {!data.enabled
                  ? "Применение выключено"
                  : unknown
                    ? "Grid неизвестен: запрошена пауза"
                    : data.withinBudget
                      ? "Подтверждено"
                      : "Переходное превышение или неполные показания"}
              </dd>
            </div>
          </dl>
          {data.enabled && unknown && (
            <p className="dispatch-notice">
              Новые старты заблокированы. Нулевая мощность считается применённой
              после подтверждения устройства; до этого порт остаётся занятым.
            </p>
          )}
          {data.sessions.length === 0 ? (
            <p className="muted">Незавершённых зарядок нет.</p>
          ) : (
            <div className="table-scroll">
              <table className="monitor-history-table">
                <thead>
                  <tr>
                    <th>Сессия / станция</th>
                    <th>Запрошено</th>
                    <th>Рассчитано</th>
                    <th>Команда</th>
                    <th>Подтверждено</th>
                    <th>Измерено</th>
                    <th>Последняя квитанция</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.stationId}</strong>
                        <small>
                          {s.id.slice(0, 8)} · {s.status} ·{" "}
                          {s.managed ? "Управляется" : "Прежний режим"}
                        </small>
                      </td>
                      <td>{watt(s.requestedW)}</td>
                      <td>{disconnected ? watt(null) : watt(s.plannedW)}</td>
                      <td>
                        {s.command ? (
                          <>
                            <strong>{watt(s.command.targetW)}</strong>
                            <small>
                              {labels[s.command.status] ?? s.command.status}
                            </small>
                            {s.command.reason && (
                              <small>{s.command.reason}</small>
                            )}
                          </>
                        ) : (
                          "Нет команды setPower"
                        )}
                      </td>
                      <td>
                        {s.effectiveAt
                          ? watt(s.acknowledgedW)
                          : "Старт ещё не подтверждён"}
                      </td>
                      <td>{disconnected ? watt(null) : watt(s.measuredW)}</td>
                      <td>
                        {s.command?.confirmedAt
                          ? dateTime(s.command.confirmedAt)
                          : s.effectiveAt
                            ? dateTime(s.effectiveAt)
                            : "Квитанции нет"}
                        <small>
                          {labels[s.reconciliation] ?? s.reconciliation}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.history.length > 0 && (
            <figure className="dispatch-comparison">
              <figcaption>
                Норма → дефицит → восстановление{" "}
                <small>
                  Последние расчёты live. Длина полосы — мощность; подтверждения
                  относятся ко времени расчёта.
                </small>
              </figcaption>
              <div className="dispatch-legend">
                <span>Сетевой бюджет</span>
                <span>Рассчитано</span>
                <span>Подтверждено на момент расчёта</span>
              </div>
              {[...data.history].reverse().map((h) => (
                <div className="dispatch-chart-row" key={h.id}>
                  <time>{dateTime(h.created_at)}</time>
                  <div>
                    {(
                      [
                        ["budget", h.budget_w],
                        ["planned", h.planned_w],
                        ["confirmed", h.acknowledged_w],
                      ] as const
                    ).map(([kind, value]) => (
                      <div
                        className={`dispatch-bar dispatch-bar--${kind}`}
                        key={kind}
                        style={{
                          width:
                            value == null
                              ? "0"
                              : `${Math.max(1, (Number(value) / max) * 100)}%`,
                        }}
                        title={`${kind}: ${value == null ? "неизвестно" : watt(Number(value))}`}
                      />
                    ))}
                  </div>
                  <small>
                    {h.budget_w === null
                      ? "Бюджет неизвестен"
                      : watt(Number(h.budget_w))}
                  </small>
                </div>
              ))}
            </figure>
          )}
        </>
      )}
    </section>
  );
}
