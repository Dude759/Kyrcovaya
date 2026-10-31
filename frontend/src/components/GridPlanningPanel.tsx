import { useEffect, useRef, useState } from "react";
import { api } from "../services/api";
import { ErrorMessage } from "./Feedback";
import { errorMessage } from "../services/errors";
import { useNow } from "../hooks/useNow";
import { dateTime, downloadCsv } from "../utils/format";
export type GridPlan = {
  grid: {
    scenario: string;
    workload: string;
    sampleId: string | null;
    version: string | null;
    asOf: string;
    operatorLimitW: number;
    budgetW: number | null;
    validity: string;
    freshnessSeconds: number;
    mode: string;
    reading: {
      availablePowerKw: number | null;
      baseLoadKw: number | null;
      receivedAt: string | null;
      status: string;
      source: "simulator";
    };
  };
  usable: boolean;
  plan: null | {
    id: string;
    version: string;
    mode: string;
    workload: string;
    createdAt: string;
    budgetW: number | null;
    assignments: {
      id: string;
      stationId: string;
      requestedW: number;
      portLimitW: number;
      stationLimitW: number;
      plannedW: number | null;
      acknowledgedW: null;
      measuredW: number | null;
      currentAllocatedW: number | null;
    }[];
  };
};
const names: Record<string, string> = {
  normal: "Нормальная мощность",
  deficit: "Дефицит",
  deep_deficit: "Глубокий дефицит",
  recovery: "Восстановление",
  offline: "Потеря связи",
  stale: "Устаревшие данные",
  missing: "Нет данных",
};
const power = (w: number | null) =>
  w === null ? "Неизвестно" : `${(w / 1000).toFixed(3)} кВт`;
export function GridPlanningPanel({
  applicationSeparate = false,
}: { applicationSeparate?: boolean } = {}) {
  const [data, setData] = useState<GridPlan | null>(null),
    [history, setHistory] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [scenario, setScenario] = useState("normal"),
    [workload, setWorkload] = useState("live");
  const key = useRef(crypto.randomUUID()),
    now = useNow();
  async function refresh() {
    const [plan, h] = await Promise.all([api.gridPlan(), api.gridHistory()]);
    setData(plan);
    setHistory(h.items);
    setCursor(h.nextCursor);
  }
  useEffect(() => {
    let live = true,
      running = false;
    async function load() {
      if (running) return;
      running = true;
      try {
        const [plan, h] = await Promise.all([
          api.gridPlan(),
          api.gridHistory(),
        ]);
        if (live) {
          setData(plan);
          setHistory(h.items);
          setCursor(h.nextCursor);
          setError("");
        }
      } catch (e) {
        if (live) setError(errorMessage(e));
      } finally {
        running = false;
      }
    }
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  const stale =
    !!data?.grid.reading.receivedAt &&
    now - Date.parse(data.grid.reading.receivedAt) >
      data.grid.freshnessSeconds * 1000;
  const usable = !!data?.usable && !stale;
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const result = await api.gridScenario(
        { scenario, workload },
        key.current,
      );
      setData(result);
      await refresh();
      key.current = crypto.randomUUID();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="record-card"
      aria-label="Планирование мощности энергосистемы"
    >
      <h2>Учебный имитатор энергосистемы</h2>
      <p>
        {applicationSeparate ? (
          <>
            <strong>Расчёт и применение показаны отдельно.</strong> При
            включённом управлении live-сценарий запускает сверку команд
            устройств. Training не применяется. Реальная энергокомпания не
            подключена.
          </>
        ) : (
          <>
            <strong>Расчёт, не применяется к зарядкам.</strong> Реальная
            энергокомпания не подключена. Сценарий меняет только расчётный план,
            а не устройства, брони или оплату.
          </>
        )}
      </p>
      <ErrorMessage message={error} />
      <div className="monitor-filters">
        <label className="field">
          <span>Сценарий энергосистемы</span>
          <select
            disabled={busy}
            value={scenario}
            onChange={(e) => {
              setScenario(e.target.value);
              key.current = crypto.randomUUID();
            }}
          >
            {Object.entries(names).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Нагрузка для расчёта</span>
          <select
            disabled={busy}
            value={workload}
            onChange={(e) => {
              setWorkload(e.target.value);
              key.current = crypto.randomUUID();
            }}
          >
            <option value="live">Текущие серверные сессии</option>
            <option value="training">
              Учебные запросы 100 / 80 / 60 / 50 кВт
            </option>
          </select>
        </label>
      </div>
      <div className="form-actions">
        <button
          className="button"
          disabled={busy}
          onClick={() => void submit()}
        >
          Рассчитать сценарий
        </button>
        <button
          className="button button--outline"
          disabled={busy}
          onClick={() => void refresh().catch((e) => setError(errorMessage(e)))}
        >
          Обновить план
        </button>
      </div>
      {data && (
        <>
          <p>
            Сохранённый сценарий: {names[data.grid.scenario]} ·{" "}
            {data.grid.workload === "training"
              ? "Учебная нагрузка: это не реальные сессии"
              : "Текущие серверные сессии"}
          </p>
          <dl className="details-list">
            <div>
              <dt>Источник и связь</dt>
              <dd>
                Имитатор ·{" "}
                {data.grid.reading.status === "offline"
                  ? "Потеря связи"
                  : stale
                    ? "Устарело"
                    : data.grid.validity === "fresh"
                      ? "Свежие данные"
                      : "Нет достоверных показаний"}
              </dd>
            </div>
            <div>
              <dt>Доступно от имитатора</dt>
              <dd>
                {data.grid.reading.availablePowerKw === null
                  ? "Неизвестно"
                  : `${data.grid.reading.availablePowerKw} кВт`}
              </dd>
            </div>
            <div>
              <dt>Базовая нагрузка имитатора</dt>
              <dd>
                {data.grid.reading.baseLoadKw === null
                  ? "Неизвестно"
                  : `${data.grid.reading.baseLoadKw} кВт`}
              </dd>
            </div>
            <div>
              <dt>Операторский лимит (конфигурация)</dt>
              <dd>{power(data.grid.operatorLimitW)}</dd>
            </div>
            <div>
              <dt>Расчётный бюджет</dt>
              <dd>{power(stale ? null : data.grid.budgetW)}</dd>
            </div>
            <div>
              <dt>Получено от имитатора</dt>
              <dd>
                {data.grid.reading.receivedAt
                  ? dateTime(data.grid.reading.receivedAt)
                  : "Нет данных"}
              </dd>
            </div>
            <div>
              <dt>Порог свежести</dt>
              <dd>{data.grid.freshnessSeconds} секунд</dd>
            </div>
          </dl>
          {!usable && (
            <p role="status">
              {applicationSeparate
                ? "Достоверного shadow-плана нет. Состояние команд и подтверждений показано в разделе применения выше."
                : "Достоверного текущего плана нет. Зарядки продолжают работать по прежним локальным правилам."}
            </p>
          )}
          {data.plan && (
            <>
              <p>
                Версия: {data.plan.version} · снимок{" "}
                {dateTime(data.plan.createdAt)}. Остаток до 1 Вт распределяется
                по стабильному ID.
              </p>
              <div className="table-scroll">
                <table className="monitor-history-table">
                  <thead>
                    <tr>
                      <th>Сессия / учебный запрос</th>
                      <th>Станция</th>
                      <th>Запрос</th>
                      <th>Предел порта</th>
                      <th>Лимит станции</th>
                      <th>Расчёт</th>
                      <th>Подтверждено setPower</th>
                      <th>Измерено в снимке</th>
                      <th>Прежнее выделение сессии</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.plan.assignments.map((a) => (
                      <tr key={a.id}>
                        <td>{a.id}</td>
                        <td>{a.stationId}</td>
                        <td>{power(a.requestedW)}</td>
                        <td>{power(a.portLimitW)}</td>
                        <td>{power(a.stationLimitW)}</td>
                        <td>{power(usable ? a.plannedW : null)}</td>
                        <td>Не применялось</td>
                        <td>{power(a.measuredW)}</td>
                        <td>{power(a.currentAllocatedW)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!data.plan.assignments.length && (
                <p>
                  Нет незавершённых сессий для распределения. Для проверки
                  алгоритма выберите явно обозначенную учебную нагрузку.
                </p>
              )}
              <button
                className="button button--outline"
                onClick={() =>
                  downloadCsv("shadow-power-plan.csv", [
                    [
                      "Источник",
                      "Режим",
                      "Нагрузка",
                      "ID",
                      "Станция",
                      "Запрос, Вт",
                      "План, Вт",
                      "Подтверждено, Вт",
                      "Измерено в снимке, Вт",
                    ],
                    ...data.plan!.assignments.map((a) => [
                      "simulator",
                      "shadow",
                      data.plan!.workload,
                      a.id,
                      a.stationId,
                      a.requestedW,
                      usable ? (a.plannedW ?? "") : "",
                      "",
                      a.measuredW ?? "",
                    ]),
                  ])
                }
              >
                CSV расчётного плана
              </button>
            </>
          )}
          <h3>История состояний имитатора</h3>
          <p>
            Исторические бюджеты рассчитаны на указанное время; это не текущая
            доступная мощность.
          </p>
          {history.map((h) => (
            <p key={h.id}>
              {dateTime(h.created_at)} · {names[h.scenario]} · {h.validity} ·
              бюджет {power(h.budget_w === null ? null : Number(h.budget_w))} ·
              simulator
            </p>
          ))}
          {cursor && (
            <button
              className="button button--outline"
              onClick={() =>
                void api
                  .gridHistory(cursor)
                  .then((h) => {
                    setHistory((v) => [...v, ...h.items]);
                    setCursor(h.nextCursor);
                  })
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              Предыдущие Grid-снимки
            </button>
          )}
        </>
      )}
    </section>
  );
}
