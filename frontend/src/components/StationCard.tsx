import { Link } from "react-router-dom";
import type { Station } from "../data";
import { statusLabels } from "../data";

type StationCardProps = {
  station: Station;
  selected?: boolean;
  onSelect?: (id: string) => void;
};

export function StationCard({ station, selected, onSelect }: StationCardProps) {
  const ports = station.connectors.reduce(
    (sum, item) => sum + item.available,
    0,
  );
  const maxPower = Math.max(...station.connectors.map((item) => item.powerKw));

  return (
    <article className={`station-card ${selected ? "is-selected" : ""}`}>
      <button
        className="station-card__select"
        type="button"
        onClick={() => onSelect?.(station.id)}
      >
        <span>
          <strong>{station.name}</strong>
          <small>{station.address}</small>
        </span>
        <span className={`status status--${station.status}`}>
          {statusLabels[station.status]}
        </span>
      </button>
      <div className="station-card__meta">
        <span>{ports} свободно</span>
        <span>до {maxPower} кВт</span>
        <span>от {station.pricePerKwh} ₽/кВт⋅ч</span>
        <Link to={`/driver/stations/${station.id}`}>Подробнее →</Link>
      </div>
    </article>
  );
}
