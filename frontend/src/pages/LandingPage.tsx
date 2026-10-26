import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PublicHeader } from "../components/PublicHeader";
import { StationMap } from "../components/StationMap";
import type { Station } from "../data";
import { api, apiMode } from "../services/api";
import { errorMessage } from "../services/errors";

export function LandingPage() {
  const [stations, setStations] = useState<Station[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    api
      .stations()
      .then((value) => {
        if (active) setStations(value);
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [retry]);
  const online = stations.filter(
    (s) => !["offline", "service"].includes(s.status),
  ).length;
  const ports = stations.reduce(
    (sum, s) => sum + s.connectors.reduce((count, c) => count + c.total, 0),
    0,
  );
  const load = stations
    .filter((s) => !["offline", "service"].includes(s.status))
    .reduce((sum, s) => sum + (s.limitKw * (s.loadPercent ?? 0)) / 100, 0);
  return (
    <div className="public-page">
      <PublicHeader />
      <main className="landing">
        <section className="landing__hero">
          <div className="landing__copy">
            <div className="eyebrow">
              <span /> Сервис зарядной инфраструктуры
            </div>
            <h1>
              Зарядка без ожидания.
              <br />
              Сеть под контролем.
            </h1>
            <p>
              Водитель заранее видит свободный разъём и стоимость.
              <br />
              Оператор — загрузку сети и доступную мощность.
            </p>
            <div className="button-row">
              <Link className="button" to="/driver/stations">
                Открыть карту
              </Link>
              <Link
                className="text-link text-link--arrow"
                to="/login?role=operator"
              >
                Вход для оператора <ArrowRight size={15} />
              </Link>
            </div>
            <dl className="network-metrics">
              <div>
                <dt>{loading || error ? "—" : stations.length}</dt>
                <dd>станций в сети</dd>
              </div>
              <div>
                <dt>{loading || error ? "—" : ports}</dt>
                <dd>зарядных разъёмов</dd>
              </div>
              <div>
                <dt>
                  {stations.length &&
                  stations.every((s) => s.loadPercent !== null)
                    ? `${(load / 1000).toFixed(2)} МВт`
                    : "—"}
                </dt>
                <dd>
                  {apiMode === "mock"
                    ? "нагрузка в демосети"
                    : "телеметрия не подключена"}
                </dd>
              </div>
            </dl>
          </div>
          <div className="landing__map">
            {error ? (
              <div className="route-state" role="alert">
                <p>{error}</p>
                <button
                  className="button"
                  onClick={() => {
                    setError("");
                    setLoading(true);
                    setRetry((value) => value + 1);
                  }}
                >
                  Повторить
                </button>
              </div>
            ) : (
              <StationMap stations={stations} compact />
            )}
            <div className="live-status">
              <div>
                <strong>
                  {loading
                    ? "Загружаем каталог…"
                    : error
                      ? "Каталог недоступен"
                      : `${online} из ${stations.length} станций доступны`}
                </strong>
                <small>
                  {apiMode === "mock"
                    ? "Обзор демонстрационной сети"
                    : "Учебный каталог из серверной базы"}
                </small>
              </div>
              <span />
            </div>
          </div>
        </section>

        <section className="landing__bottom" id="about">
          <div className="driver-route">
            <span className="section-label">Водителю</span>
            <h2>От адреса до начала зарядки — один понятный маршрут</h2>
            <ol>
              {["Найти станцию", "Выбрать время", "Начать зарядку"].map(
                (item, index) => (
                  <li key={item}>
                    <small>0{index + 1}</small>
                    <span>{item}</span>
                    {index < 2 && <ArrowRight size={17} />}
                  </li>
                ),
              )}
            </ol>
          </div>
          <div className="operator-entry">
            <span>Для организаций</span>
            <h2>
              Мониторинг и управление
              <br />
              зарядной сетью
            </h2>
            <Link to="/login?role=operator">
              Войти как оператор <ArrowRight size={15} />
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
