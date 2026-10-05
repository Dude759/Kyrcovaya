import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { PublicHeader } from "../components/PublicHeader";
import { StationMap } from "../components/StationMap";
import { stations } from "../data";

export function LandingPage() {
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
                <dt>{stations.length}</dt>
                <dd>станций в сети</dd>
              </div>
              <div>
                <dt>{ports}</dt>
                <dd>зарядных разъёмов</dd>
              </div>
              <div>
                <dt>{(load / 1000).toFixed(2)} МВт</dt>
                <dd>нагрузка в демосети</dd>
              </div>
            </dl>
          </div>
          <div className="landing__map">
            <StationMap stations={stations} compact />
            <div className="live-status">
              <div>
                <strong>
                  {online} из {stations.length} станций доступны
                </strong>
                <small>Обзор демонстрационной сети</small>
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
