import { useState } from "react";
import { useAction } from "../hooks/useAction";
import { useNow } from "../hooks/useNow";
import { api, apiMode } from "../services/api";
import type { Forecast } from "../types/domain";
import { dateTime } from "../utils/format";
import { ErrorMessage } from "./Feedback";
import { LoadForecast } from "./LoadForecast";

export function ForecastPanel({
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
