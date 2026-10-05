import { useMemo, useState } from "react";
import { directionsUrl } from "../utils/maps";
import { Search } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { StationMap } from "../components/StationMap";
import { StationCard } from "../components/StationCard";
import { EmptyState } from "../components/Feedback";
import { statusLabels } from "../data";
import { useApp } from "../state/context";

export function DriverMapPage() {
  const { data } = useApp();
  const stations = data!.stations;
  const [search, setSearch] = useState("");
  const [availableOnly, setAvailableOnly] = useState(true);
  const [highPower, setHighPower] = useState(false);
  const [connector, setConnector] = useState("all");
  const [selectedId, setSelectedId] = useState(stations[0]?.id);
  const filtered = useMemo(
    () =>
      stations.filter(
        (s) =>
          `${s.name} ${s.address} ${s.district}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()) &&
          (!availableOnly || !["offline", "service"].includes(s.status)) &&
          s.connectors.some(
            (c) =>
              (connector === "all" || c.type === connector) &&
              (!availableOnly || c.available > 0) &&
              (!highPower || c.powerKw >= 100),
          ),
      ),
    [stations, search, availableOnly, highPower, connector],
  );
  const selected = filtered.some((s) => s.id === selectedId)
    ? selectedId
    : filtered[0]?.id;
  return (
    <AppShell
      role="driver"
      active="stations"
      title="Зарядные станции"
      subtitle="Найдите подходящую станцию рядом"
    >
      <div className="stations-layout">
        <aside className="station-results">
          <label className="search-field">
            <Search size={18} />
            <input
              aria-label="Поиск станций"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Адрес, район или станция"
            />
          </label>
          <div className="filters">
            <button
              className={availableOnly ? "is-active" : ""}
              aria-pressed={availableOnly}
              onClick={() => setAvailableOnly(!availableOnly)}
            >
              Свободны сейчас
            </button>
            <button
              className={highPower ? "is-active" : ""}
              aria-pressed={highPower}
              onClick={() => setHighPower(!highPower)}
            >
              ≥ 100 кВт
            </button>
            <select
              aria-label="Тип разъёма"
              value={connector}
              onChange={(e) => setConnector(e.target.value)}
            >
              <option value="all">Все разъёмы</option>
              <option>CCS2</option>
              <option>CHAdeMO</option>
              <option>Type 2</option>
            </select>
          </div>
          <p className="result-count" aria-live="polite">
            Найдено станций: {filtered.length}
          </p>
          <div className="station-list">
            {filtered.map((station) => (
              <StationCard
                key={station.id}
                station={station}
                selected={selected === station.id}
                onSelect={setSelectedId}
              />
            ))}
            {!filtered.length && (
              <EmptyState
                title="Станции не найдены"
                text="Попробуйте другой адрес или сбросьте фильтры."
              />
            )}
          </div>
        </aside>
        <StationMap
          stations={filtered}
          selectedId={selected}
          onSelect={setSelectedId}
        />
      </div>
    </AppShell>
  );
}
export function StationPage() {
  const { stationId } = useParams();
  const { data } = useApp();
  const station = data!.stations.find((s) => s.id === stationId);
  if (!station)
    return (
      <AppShell
        role="driver"
        active="stations"
        title="Станция не найдена"
        subtitle="Проверьте адрес страницы"
      >
        <EmptyState title="Такой станции нет" to="/driver/stations" />
      </AppShell>
    );
  const bookable =
    !["offline", "service"].includes(station.status) &&
    station.connectors.some((c) => c.available > 0);
  return (
    <AppShell
      role="driver"
      active="stations"
      title={station.name}
      subtitle="Информация о станции и доступных разъёмах"
    >
      <div className="station-detail-layout">
        <StationMap stations={data!.stations} selectedId={station.id} />
        <section className="station-detail">
          <span className={`status status--${station.status}`}>
            {statusLabels[station.status]}
          </span>
          <h2>{station.name}</h2>
          <p>{station.address}</p>
          <hr />
          <h3>Доступные разъёмы</h3>
          <div className="connector-table">
            <div className="connector-table__head">
              <span>Тип</span>
              <span>Мощность</span>
              <span>Доступность</span>
            </div>
            {station.connectors.map((c) => (
              <div key={c.type}>
                <strong>{c.type}</strong>
                <span>{c.powerKw} кВт</span>
                <span className={c.available ? "available-text" : ""}>
                  {c.available ? `${c.available} свободно` : "Нет свободных"}
                </span>
              </div>
            ))}
          </div>
          <h3>Условия</h3>
          <dl className="details-list">
            <div>
              <dt>Тариф</dt>
              <dd>{station.pricePerKwh} ₽/кВт⋅ч</dd>
            </div>
            <div>
              <dt>Парковка</dt>
              <dd>Бесплатно 2 часа</dd>
            </div>
            <div>
              <dt>Режим работы</dt>
              <dd>Круглосуточно</dd>
            </div>
          </dl>
          <p className="updated">{station.district}</p>
          <a
            className="station-directions"
            href={directionsUrl(station.coordinates)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Маршрут в Яндекс Картах ↗
          </a>
          {bookable ? (
            <Link
              className="button button--full"
              to={`/driver/booking?station=${station.id}`}
            >
              Забронировать
            </Link>
          ) : (
            <button className="button button--full" disabled>
              Бронирование недоступно
            </button>
          )}
        </section>
      </div>
    </AppShell>
  );
}
