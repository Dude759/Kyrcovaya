import { LocateFixed, Minus, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Station } from "../data";
import { stations as seedStations, statusLabels } from "../data";

type StationMapProps = {
  stations: Station[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  compact?: boolean;
};

const fallbackPositions = [
  [24, 19],
  [46, 27],
  [76, 18],
  [29, 46],
  [62, 51],
  [84, 69],
  [49, 81],
];

let mapsScript: Promise<void> | null = null;

function loadYandexMaps(apiKey: string) {
  if (typeof ymaps3 !== "undefined") return Promise.resolve();
  if (mapsScript) return mapsScript;

  mapsScript = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(apiKey)}&lang=ru_RU`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error("Не удалось загрузить Yandex Maps API"));
    document.head.appendChild(script);
  });

  return mapsScript;
}

export function StationMap({
  stations,
  selectedId,
  onSelect,
  compact = false,
}: StationMapProps) {
  const apiKey = import.meta.env.VITE_YANDEX_MAPS_API_KEY as string | undefined;
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const selected = useMemo(
    () => stations.find((station) => station.id === selectedId) ?? stations[0],
    [selectedId, stations],
  );

  const instance = useRef<InstanceType<typeof ymaps3.YMap> | null>(null);
  const [ready, setReady] = useState(false);
  const [mapNotice, setMapNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const selectRef = useRef(onSelect);
  useEffect(() => {
    selectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!apiKey || !mapRef.current) return;
    let cancelled = false;
    let map: InstanceType<typeof ymaps3.YMap> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function init() {
      try {
        await Promise.race([
          loadYandexMaps(apiKey!).then(() => ymaps3.ready),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), 12000);
          }),
        ]);
        if (cancelled || !mapRef.current) return;
        map = new ymaps3.YMap(mapRef.current, {
          location: { center: [37.6176, 55.7558], zoom: compact ? 10 : 11 },
        });
        map.addChild(new ymaps3.YMapDefaultSchemeLayer({}));
        map.addChild(new ymaps3.YMapDefaultFeaturesLayer({ zIndex: 1800 }));
        instance.current = map;
        setReady(true);
      } catch {
        if (!cancelled) {
          mapsScript = null;
          setMapFailed(true);
        }
      } finally {
        clearTimeout(timer);
      }
    }
    void init();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      map?.destroy();
      instance.current = null;
    };
  }, [apiKey, compact, retry]);

  useEffect(() => {
    const map = instance.current;
    if (!ready || !map) return;
    let cancelled = false;
    const collection = new ymaps3.YMapCollection({});
    const marker = (station: Station) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = `yandex-marker status-marker--${station.status} ${station.id === selectedId ? "is-selected" : ""}`;
      element.ariaLabel = `${station.name}, ${statusLabels[station.status]}`;
      element.addEventListener("click", () => selectRef.current?.(station.id));
      return new ymaps3.YMapMarker(
        { coordinates: station.coordinates },
        element,
      );
    };
    async function addMarkers() {
      try {
        const { YMapClusterer, clusterByGrid } = await (
          ymaps3.import as unknown as (
            pkg: string,
          ) => Promise<typeof import("@yandex/ymaps3-types/packages/clusterer")>
        )("@yandex/ymaps3-clusterer");
        if (cancelled) return;
        collection.addChild(
          new YMapClusterer({
            method: clusterByGrid({ gridSize: 64 }),
            features: stations.map((station) => ({
              type: "Feature" as const,
              id: station.id,
              geometry: {
                type: "Point" as const,
                coordinates: station.coordinates,
              },
            })),
            marker: (feature) =>
              marker(stations.find((station) => station.id === feature.id)!),
            cluster: (coordinates, features) => {
              const element = document.createElement("button");
              element.type = "button";
              element.className = "map-cluster";
              element.textContent = String(features.length);
              element.ariaLabel = `Группа: ${features.length} станций`;
              element.addEventListener("click", () =>
                map!.setLocation({
                  center: coordinates,
                  zoom: Math.min(map!.zoom + 2, 18),
                  duration: 300,
                }),
              );
              return new ymaps3.YMapMarker({ coordinates }, element);
            },
          }),
        );
      } catch {
        if (!cancelled)
          stations.forEach((station) => collection.addChild(marker(station)));
      }
      if (!cancelled) map!.addChild(collection);
    }
    void addMarkers();
    return () => {
      cancelled = true;
      if (collection.parent === map) map.removeChild(collection);
    };
  }, [ready, stations, selectedId]);

  const longitude = selected?.coordinates[0];
  const latitude = selected?.coordinates[1];
  // Apply the initial station camera before the location controls become interactive.
  useLayoutEffect(() => {
    if (
      ready &&
      longitude !== undefined &&
      latitude !== undefined &&
      selectedId
    )
      instance.current?.setLocation({
        center: [longitude, latitude],
        zoom: 13,
        duration: 400,
      });
  }, [ready, longitude, latitude, selectedId]);

  function locate() {
    if (!navigator.geolocation) {
      setMapNotice("Геолокация не поддерживается браузером.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        instance.current?.setLocation({
          center: [position.coords.longitude, position.coords.latitude],
          zoom: 13,
          duration: 400,
        });
        setMapNotice("Карта перемещена к вашему местоположению.");
      },
      () =>
        setMapNotice(
          "Местоположение недоступно. Разрешите геолокацию в браузере.",
        ),
      { timeout: 10000 },
    );
  }

  const showFallback = !apiKey || mapFailed;

  return (
    <section
      className={`map-canvas ${compact ? "map-canvas--compact" : ""}`}
      aria-label="Карта зарядных станций"
    >
      {showFallback ? (
        <div className="map-fallback">
          <div className="map-fallback__river" />
          {Array.from({ length: 12 }, (_, index) => (
            <span className={`map-block map-block--${index + 1}`} key={index} />
          ))}
          {Array.from({ length: 7 }, (_, index) => (
            <span className={`map-road map-road--${index + 1}`} key={index} />
          ))}
          <span className="map-label map-label--district">
            Пресненский район
          </span>
          <span className="map-label map-label--street">Тверская улица</span>
          <span className="map-label map-label--river">Москва-река</span>
          {stations.slice(0, fallbackPositions.length).map((station) => (
            <button
              className={`map-marker status-marker--${station.status} ${station.id === selected?.id ? "is-selected" : ""}`}
              style={{
                left: `${fallbackPositions[seedStations.findIndex((s) => s.id === station.id) % fallbackPositions.length]?.[0] ?? 50}%`,
                top: `${fallbackPositions[seedStations.findIndex((s) => s.id === station.id) % fallbackPositions.length]?.[1] ?? 50}%`,
              }}
              type="button"
              onClick={() => onSelect?.(station.id)}
              aria-label={`Выбрать станцию ${station.name}`}
              key={station.id}
            />
          ))}
          <span className="map-copyright">
            Схематическая карта · демонстрация
          </span>
        </div>
      ) : (
        <div className="yandex-map" ref={mapRef} />
      )}

      <span className="map-location">Москва · ЦАО</span>
      {!showFallback && !compact && (
        <div className="map-controls">
          <button
            aria-label="Приблизить карту"
            disabled={!ready}
            onClick={() =>
              instance.current?.setLocation({
                zoom: Math.min((instance.current?.zoom ?? 11) + 1, 20),
                duration: 200,
              })
            }
          >
            <Plus size={18} />
          </button>
          <button
            aria-label="Отдалить карту"
            disabled={!ready}
            onClick={() =>
              instance.current?.setLocation({
                zoom: Math.max((instance.current?.zoom ?? 11) - 1, 3),
                duration: 200,
              })
            }
          >
            <Minus size={18} />
          </button>
          <button
            aria-label="Моё местоположение"
            disabled={!ready}
            onClick={locate}
          >
            <LocateFixed size={17} />
          </button>
        </div>
      )}
      {!showFallback && !ready && (
        <span className="map-notice" role="status">
          Загрузка карты…
        </span>
      )}
      {mapNotice && (
        <span className="map-notice" role="status">
          {mapNotice}
          <button
            className="map-notice-close"
            aria-label="Закрыть сообщение карты"
            onClick={() => setMapNotice("")}
          >
            ×
          </button>
        </span>
      )}
      {mapFailed && (
        <div className="map-notice" role="alert">
          Карта недоступна. Показана схема.{" "}
          <button
            onClick={() => {
              setMapFailed(false);
              setReady(false);
              setRetry((value) => value + 1);
            }}
          >
            Повторить
          </button>
        </div>
      )}
      {selected && !compact && (
        <article className="map-selection">
          <span className={`status status--${selected.status}`}>
            {statusLabels[selected.status]}
          </span>
          <strong>{selected.name}</strong>
          <small>
            {Math.max(...selected.connectors.map((item) => item.powerKw))} кВт ·{" "}
            {selected.connectors.reduce((sum, item) => sum + item.available, 0)}{" "}
            свободно
          </small>
          <Link to={`/driver/stations/${selected.id}`}>Открыть →</Link>
        </article>
      )}
    </section>
  );
}
