import { useState } from "react";
import type { Forecast } from "../types/domain";
import { dateTime, downloadCsv } from "../utils/format";

const hourLabel = (time: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(time));

export function LoadForecast({
  forecast,
  networkLimit,
}: {
  forecast: Forecast | null;
  networkLimit: number;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  if (!forecast?.points.length)
    return (
      <section className="dashboard-panel forecast-panel">
        <h2>Прогноз нагрузки</h2>
        <p>
          Прогноз пока недоступен. Он появится после получения данных модели.
        </p>
      </section>
    );
  const points = forecast.points;
  const experiment = forecast.source === "synthetic";
  const max =
    Math.max(
      experiment ? 1 : 1000,
      ...points.flatMap((p) => [p.powerKw, p.lastKw ?? 0, p.weeklyKw ?? 0]),
    ) * 1.15;
  const peak = points.reduce((a, b) => (a.powerKw > b.powerKw ? a : b));
  const current = selected === null ? peak : (points[selected] ?? peak);
  const x = (i: number) => 64 + (i / Math.max(points.length - 1, 1)) * 816;
  const y = (value: number) => 180 - (value / max) * 156;
  const polyline = points.map((p, i) => `${x(i)},${y(p.powerKw)}`).join(" ");
  return (
    <section className="dashboard-panel forecast-panel">
      <div className="page-toolbar">
        <div>
          <h2>Прогноз нагрузки · 24 часа</h2>
          <p>
            {experiment
              ? `Synthetic · исторический replay · ${forecast.modelVersion}`
              : forecast.source === "demo"
                ? "Демонстрационный сценарий. ML-модель пока не подключена."
                : `Расчёт модели от ${dateTime(forecast.generatedAt)}`}
          </p>
          {experiment && (
            <>
              <p>
                Origin: {forecast.origin} · Расчёт Python:{" "}
                {forecast.generatedAt}
              </p>
              <p>
                24 следующих часа относительно исторического origin, не прогноз
                на сегодня. Качество: {forecast.quality}.
              </p>
            </>
          )}
        </div>
        <button
          className="button button--outline"
          onClick={() =>
            downloadCsv("load-forecast.csv", [
              ["Время", "Прогноз,кВт", "Источник"],
              ...points.map((p) => [
                dateTime(p.time),
                p.powerKw,
                forecast.source,
              ]),
            ])
          }
        >
          Экспорт прогноза
        </button>
      </div>
      <div className="forecast-summary">
        <span>
          {selected === null ? "Ожидаемый пик" : "Нагрузка в выбранный час"}:{" "}
          <strong>
            {experiment
              ? `${current.powerKw.toFixed(2)} кВт`
              : `${(current.powerKw / 1000).toFixed(2)} МВт`}
          </strong>{" "}
          · {hourLabel(current.time)}
        </span>
        <span>
          {experiment
            ? "RF / last observation / weekly baseline"
            : `${Math.round((peak.powerKw / networkLimit) * 100)}% лимита сети в пиковый час`}
        </span>
      </div>
      <div className="forecast-chart-scroll">
        <svg
          className="forecast-chart"
          viewBox="0 0 910 218"
          role="img"
          aria-label={`Прогноз нагрузки на сутки${experiment ? " · исторический synthetic" : ""}. Пик ${experiment ? peak.powerKw.toFixed(2) + " кВт" : (peak.powerKw / 1000).toFixed(2) + " МВт"} в ${hourLabel(peak.time)}.`}
        >
          {[0, 1, 2, 3].map((i) => {
            const value = (max / 3) * i;
            return (
              <g key={i}>
                <line
                  x1="64"
                  x2="880"
                  y1={y(value)}
                  y2={y(value)}
                  stroke="#e4e8e3"
                />
                <text x="50" y={y(value) + 4} textAnchor="end">
                  {(experiment ? value : value / 1000).toFixed(1)}
                </text>
              </g>
            );
          })}
          {!experiment && (
            <polygon
              points={`64,180 ${polyline} ${x(points.length - 1)},180`}
              fill="#edf4ec"
            />
          )}
          {experiment &&
            (["lastKw", "weeklyKw"] as const).flatMap((key) => {
              const segments: string[][] = [[]];
              points.forEach((p, i) => {
                const value = p[key];
                if (value == null) {
                  if (segments[segments.length - 1].length) segments.push([]);
                } else
                  segments[segments.length - 1].push(`${x(i)},${y(value)}`);
              });
              return segments
                .filter((s) => s.length)
                .map((s, i) => (
                  <polyline
                    key={key + i}
                    points={s.join(" ")}
                    fill="none"
                    stroke={key === "lastKw" ? "#8a6d3a" : "#667b9a"}
                    strokeWidth="2"
                    strokeDasharray={key === "lastKw" ? "7 4" : "3 3"}
                  />
                ));
            })}
          <polyline
            points={polyline}
            fill="none"
            stroke="#27724d"
            strokeWidth="2.5"
          />
          {points.map((p, i) => (
            <g key={p.time}>
              {i % 6 === 0 && (
                <text x={x(i)} y="206" textAnchor="middle">
                  {hourLabel(p.time)}
                </text>
              )}
              {selected === i && (
                <circle
                  cx={x(i)}
                  cy={y(p.powerKw)}
                  r="5"
                  fill="#27724d"
                  stroke="white"
                  strokeWidth="2"
                />
              )}
            </g>
          ))}
        </svg>
      </div>
      <label className="forecast-hour">
        Час прогноза{" "}
        <select
          value={selected ?? "peak"}
          onChange={(e) =>
            setSelected(
              e.target.value === "peak" ? null : Number(e.target.value),
            )
          }
        >
          <option value="peak">Пиковая нагрузка</option>
          {points.map((p, i) => (
            <option key={p.time} value={i}>
              {dateTime(p.time)}
            </option>
          ))}
        </select>
        <span>Мощность, {experiment ? "кВт" : "МВт"} · московское время</span>
      </label>
      {experiment && forecast.metrics && (
        <>
          <p>
            Сплошная зелёная линия: RF. Коричневый пунктир: last observation.
            Синий пунктир: weekly. Отсутствующий baseline час не дорисовывается.
          </p>
          <h3>Оценка только на synthetic test</h3>
          <div className="table-scroll">
            <table className="monitor-history-table">
              <thead>
                <tr>
                  <th>Метод</th>
                  <th>MAE, кВт</th>
                  <th>RMSE, кВт</th>
                  <th>Общих пар origin/h</th>
                </tr>
              </thead>
              <tbody>
                {(["rf", "last", "weekly"] as const).map((m) => (
                  <tr key={m}>
                    <td>
                      {m === "rf"
                        ? "RandomForestRegressor"
                        : m === "last"
                          ? "Last observation"
                          : "Weekly baseline"}
                    </td>
                    <td>
                      {forecast.metrics!.test.aggregate[m].mae_kw.toFixed(3)}
                    </td>
                    <td>
                      {forecast.metrics!.test.aggregate[m].rmse_kw.toFixed(3)}
                    </td>
                    <td>{forecast.metrics!.test.aggregate[m].n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            {forecast.metrics.test.origins} origins · coverage{" "}
            {(forecast.metrics.test.coverage * 100).toFixed(2)}% допустимых пар.
            Это покрытие данных, не процент точности. Перекрывающиеся пары не
            являются независимыми физическими часами.
          </p>
        </>
      )}
    </section>
  );
}
