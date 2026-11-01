import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAction } from "../hooks/useAction";
import { useNow } from "../hooks/useNow";
import { api, apiMode } from "../services/api";
import type { Forecast } from "../types/domain";
import { dateTime } from "../utils/format";
import { ErrorMessage } from "./Feedback";
import { LoadForecast } from "./LoadForecast";

export function ForecastPanel(props: {
  forecast: Forecast | null;
  networkLimit: number;
}) {
  return apiMode === "http" ? (
    <ServerForecastPanel />
  ) : (
    <MockForecastPanel {...props} />
  );
}
function ServerForecastPanel() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<Awaited<
      ReturnType<typeof api.forecastStatus>
    > | null>(null),
    [demo, setDemo] = useState<Forecast | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  async function load(includeDemo: boolean) {
    setBusy(true);
    setError("");
    try {
      setStatus(await api.forecastStatus());
      if (includeDemo) setDemo((await api.forecastDemo()).forecast);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Прогноз недоступен");
    } finally {
      setBusy(false);
    }
  }
  const opened = params.get("forecast") === "demo";
  useEffect(() => {
    let cancelled = false;
    async function initialRead() {
      try {
        const nextStatus = await api.forecastStatus();
        if (!cancelled) setStatus(nextStatus);
        const nextDemo = opened ? (await api.forecastDemo()).forecast : null;
        if (!cancelled) {
          if (nextDemo) setDemo(nextDemo);
          setError("");
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Прогноз недоступен");
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    void initialRead();
    return () => {
      cancelled = true;
    };
  }, [opened]);
  return (
    <section
      className="record-card forecast-container"
      aria-label="ML-прогноз"
      aria-busy={busy}
    >
      <h2>Прогноз нагрузки рабочей сети</h2>
      <p role="status">
        {busy
          ? "Загрузка прогноза…"
          : status
            ? "NEEDS_MORE_DATA · Недостаточно полных данных"
            : "Прогноз недоступен"}
      </p>
      {status && (
        <>
          <p>{status.reason}</p>
          <p>
            Полных станционных часов: {status.quality.completeStationHours} из{" "}
            {status.quality.stationHours}. Достоверного прогноза рабочей сети
            нет.
          </p>
        </>
      )}
      <ErrorMessage message={error} />
      <div className="checkout-actions">
        <button
          className="button button--outline"
          disabled={busy}
          onClick={() => void load(opened)}
        >
          Проверить доступность прогноза
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() => {
            if (opened) void load(true);
            else {
              setBusy(true);
              setError("");
              setParams(
                (p) => {
                  p.set("forecast", "demo");
                  return p;
                },
                { replace: true },
              );
            }
          }}
        >
          Открыть учебный ML-эксперимент
        </button>
      </div>
      <p>
        Новый расчёт на сервере не запускается: доступен сохранённый
        исторический replay Python-модели. Прогноз не управляет Grid Dispatch.
      </p>
      {demo && (
        <>
          <p className="forecast-warning" role="status">
            Устаревший для текущей сети: это исторический synthetic эксперимент.
            Качество на реальной сети не подтверждено.
          </p>
          <LoadForecast forecast={demo} networkLimit={0} />
        </>
      )}
    </section>
  );
}
function MockForecastPanel({
  forecast,
  networkLimit,
}: {
  forecast: Forecast | null;
  networkLimit: number;
}) {
  const [updated, setUpdated] = useState<Forecast | null | undefined>(
    undefined,
  );
  const action = useAction();
  const now = useNow();
  const current = updated === undefined ? forecast : updated;
  const stale = current && now - Date.parse(current.generatedAt) > 3600000;
  async function reload(
    scenario: "ready" | "error" | "empty" | "stale" = "ready",
  ) {
    await action.run(async () => setUpdated(await api.forecast(scenario)));
  }
  return (
    <div className="forecast-container" aria-busy={action.busy}>
      <div className="forecast-update">
        <span role="status">
          {action.busy
            ? "Обновляем прогноз…"
            : current
              ? `Последний расчёт: ${dateTime(current.generatedAt)}`
              : "Прогноз ещё не рассчитан"}
        </span>
        <button
          className="button button--outline"
          disabled={action.busy}
          onClick={() => void reload()}
        >
          {action.busy
            ? "Обновляем…"
            : action.error
              ? "Повторить расчёт"
              : "Обновить прогноз"}
        </button>
      </div>
      <ErrorMessage message={action.error} />
      {action.error && current && (
        <p className="forecast-warning">
          Отображён предыдущий расчёт. Его значения могут быть неактуальны.
        </p>
      )}
      {stale && (
        <p className="forecast-warning" role="status">
          Прогноз устарел: с момента расчёта прошло больше часа. Обновите его
          перед распределением мощности.
        </p>
      )}
      <LoadForecast forecast={current} networkLimit={networkLimit} />
      {apiMode === "mock" && (
        <details className="demo-controls">
          <summary>Проверить состояния прогноза · демо</summary>
          <div className="checkout-actions">
            <button
              className="button button--outline"
              disabled={action.busy}
              onClick={() => void reload("error")}
            >
              Ошибка расчёта
            </button>
            <button
              className="button button--outline"
              disabled={action.busy}
              onClick={() => void reload("empty")}
            >
              Нет данных
            </button>
            <button
              className="button button--outline"
              disabled={action.busy}
              onClick={() => void reload("stale")}
            >
              Устаревший прогноз
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
