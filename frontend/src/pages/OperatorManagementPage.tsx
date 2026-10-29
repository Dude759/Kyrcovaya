import { useEffect, useRef, useState } from "react";
import { AppShell } from "../components/AppShell";
import { Modal } from "../components/Modal";
import { ErrorMessage } from "../components/Feedback";
import { api } from "../services/api";
import { useApp } from "../state/context";
import { errorMessage } from "../services/errors";
export type ManagedStation = {
  id: string;
  name: string;
  address: string;
  district: string;
  coordinates: [number, number];
  maxPowerKw: number;
  limitKw: number;
  pricePerKwh: number;
  status: string;
  archivedAt: string | null;
};
export type ManagedPort = {
  id: string;
  stationId: string;
  label: string;
  type: string;
  maxPowerKw: number;
  status: string;
  archivedAt: string | null;
};
export function OperatorManagementPage() {
  const { refresh } = useApp();
  const [stations, setStations] = useState<ManagedStation[]>([]),
    [ports, setPorts] = useState<ManagedPort[]>([]),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const [form, setForm] = useState<{
      kind: "station" | "port";
      id?: string;
      draft: Record<string, string>;
    } | null>(null),
    [archive, setArchive] = useState<{
      kind: "station" | "port";
      id: string;
    } | null>(null);
  const [events, setEvents] = useState<
      Array<{
        id: string;
        actorId: string;
        stationId: string;
        action: string;
        date: string;
      }>
    >([]),
    [cursor, setCursor] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const station = stations.find((s) => s.id === selected);
  useEffect(() => {
    let live = true;
    void api
      .operatorStations()
      .then((r) => {
        if (live) {
          setStations(r.items);
          setSelected((v) => v || r.items.find((s) => !s.archivedAt)?.id || "");
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    void api
      .operatorEvents()
      .then((r) => {
        if (live) {
          setEvents(r.items);
          setCursor(r.nextCursor);
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [revision]);
  useEffect(() => {
    let live = true;
    if (selected)
      void api
        .operatorPorts(selected)
        .then((r) => {
          if (live) setPorts(r.items);
        })
        .catch((e) => {
          if (live) setError(errorMessage(e));
        });
    return () => {
      live = false;
    };
  }, [selected, revision]);
  function openStation(s?: ManagedStation) {
    key.current = crypto.randomUUID();
    setError("");
    setForm({
      kind: "station",
      id: s?.id,
      draft: {
        name: s?.name ?? "Учебная станция",
        address: s?.address ?? "",
        district: s?.district ?? "",
        longitude: String(s?.coordinates[0] ?? 37.62),
        latitude: String(s?.coordinates[1] ?? 55.75),
        maxPowerKw: String(s?.maxPowerKw ?? 100),
        limitKw: String(s?.limitKw ?? 100),
        pricePerKwh: String(s?.pricePerKwh ?? 18),
        ...(s ? { status: s.status } : {}),
      },
    });
  }
  function openPort(p?: ManagedPort) {
    key.current = crypto.randomUUID();
    setError("");
    setForm({
      kind: "port",
      id: p?.id,
      draft: {
        label: p?.label ?? "Порт " + (ports.length + 1),
        type: p?.type ?? "CCS2",
        maxPowerKw: String(p?.maxPowerKw ?? 22),
        status: p?.status ?? "idle",
      },
    });
  }
  async function act(operation: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await operation();
      setForm(null);
      setArchive(null);
      setRevision((v) => v + 1);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!form) return;
    const d = form.draft;
    const payload =
      form.kind === "station"
        ? {
            name: d.name,
            address: d.address,
            district: d.district,
            coordinates: [Number(d.longitude), Number(d.latitude)],
            maxPowerKw: Number(d.maxPowerKw),
            limitKw: Number(d.limitKw),
            pricePerKwh: Number(d.pricePerKwh),
            ...(form.id ? { status: d.status } : {}),
          }
        : {
            label: d.label,
            type: d.type,
            maxPowerKw: Number(d.maxPowerKw),
            status: d.status,
          };
    const path =
      form.kind === "station"
        ? `stations${form.id ? "/" + form.id : ""}`
        : form.id
          ? "connectors/" + form.id
          : `stations/${selected}/connectors`;
    const result = await api.operatorSave(
      path,
      payload,
      form.id ? "PATCH" : "POST",
      form.id ? undefined : key.current,
    );
    if (form.kind === "station") setSelected(result.id);
  }
  const labels: Record<string, string> = {
    name: "Название",
    address: "Адрес",
    district: "Район",
    longitude: "Долгота",
    latitude: "Широта",
    maxPowerKw: "Максимальная мощность, кВт",
    limitKw: "Локальный лимит, кВт",
    pricePerKwh: "Тариф, ₽/кВт⋅ч",
    label: "Обозначение порта",
    type: "Тип разъёма",
    status: "Режим",
  };
  return (
    <AppShell
      role="operator"
      active="stations"
      title="Станции организации"
      subtitle="Учебные объекты · локальные ограничения мощности"
    >
      <p className="demo-note">
        Управление учебным каталогом. Реальная станция и энергосистема не
        подключены. Диагностика: нет данных без подтверждённых измерений.
      </p>
      {!form && !archive && <ErrorMessage message={error} />}
      <button className="button" onClick={() => openStation()}>
        Создать станцию
      </button>
      <div className="record-grid">
        {stations.map((s) => (
          <article className="record-card" key={s.id}>
            <h2>{s.name}</h2>
            <p>{s.address}</p>
            <p>
              {s.archivedAt
                ? "Архив"
                : s.status === "online"
                  ? "Рабочий режим"
                  : s.status === "service"
                    ? "Сервисный режим"
                    : "Отключена"}{" "}
              · {s.limitKw} кВт · {s.pricePerKwh} ₽/кВт⋅ч
            </p>
            <button
              className="button button--outline"
              onClick={() => setSelected(s.id)}
            >
              Порты: {s.name}
            </button>
            {!s.archivedAt && (
              <>
                <button
                  className="button button--outline"
                  onClick={() => openStation(s)}
                >
                  Редактировать: {s.name}
                </button>
                <button
                  className="button button--outline"
                  onClick={() => {
                    setError("");
                    setArchive({ kind: "station", id: s.id });
                  }}
                >
                  Архивировать: {s.name}
                </button>
              </>
            )}
          </article>
        ))}
      </div>
      {station && (
        <section className="record-card">
          <h2>Физические порты · {station.name}</h2>
          <p>
            Координаты: {station.coordinates.join(", ")}. Связь: нет данных.
          </p>
          {!station.archivedAt && (
            <button className="button" onClick={() => openPort()}>
              Добавить порт
            </button>
          )}
          {ports.map((p) => (
            <article key={p.id}>
              <h3>
                {p.label} · {p.type}
              </h3>
              <p>
                {p.maxPowerKw} кВт · {p.archivedAt ? "Архив" : p.status} ·{" "}
                {p.id}
              </p>
              {!p.archivedAt && !station.archivedAt && (
                <>
                  <button
                    className="button button--outline"
                    onClick={() => openPort(p)}
                  >
                    Редактировать порт: {p.label}
                  </button>
                  <button
                    className="button button--outline"
                    onClick={() => {
                      setError("");
                      setArchive({ kind: "port", id: p.id });
                    }}
                  >
                    Архивировать порт: {p.label}
                  </button>
                </>
              )}
            </article>
          ))}
        </section>
      )}
      <section className="record-card">
        <h2>Журнал организации</h2>
        {events.map((e) => (
          <p key={e.id}>
            {new Date(e.date).toLocaleString("ru-RU")} · {e.action} ·{" "}
            {e.stationId} · оператор {e.actorId}
          </p>
        ))}
        {cursor && (
          <button
            className="button"
            onClick={() =>
              void (async () => {
                try {
                  const r = await api.operatorEvents(cursor);
                  setEvents((v) => [...v, ...r.items]);
                  setCursor(r.nextCursor);
                } catch (e) {
                  setError(errorMessage(e));
                }
              })()
            }
          >
            Предыдущие события
          </button>
        )}
      </section>
      {form && (
        <Modal
          title={
            form.kind === "station"
              ? form.id
                ? "Редактирование станции"
                : "Новая учебная станция"
              : form.id
                ? "Редактирование порта"
                : "Новый физический порт"
          }
          onClose={() => !busy && setForm(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(save);
            }}
          >
            <ErrorMessage message={error} />
            {Object.entries(form.draft).map(([field, value]) => (
              <label key={field} className="field">
                <span>{labels[field]}</span>
                {field === "status" || field === "type" ? (
                  <select
                    aria-label={labels[field]}
                    value={value}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        draft: { ...form.draft, [field]: e.target.value },
                      })
                    }
                  >
                    {(field === "type"
                      ? ["CCS2", "CHAdeMO", "Type 2"]
                      : form.kind === "station"
                        ? ["service", "online", "offline"]
                        : ["idle", "service", "offline"]
                    ).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label={labels[field]}
                    required={field !== "district"}
                    type={
                      [
                        "longitude",
                        "latitude",
                        "maxPowerKw",
                        "limitKw",
                        "pricePerKwh",
                      ].includes(field)
                        ? "number"
                        : "text"
                    }
                    step="any"
                    value={value}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        draft: { ...form.draft, [field]: e.target.value },
                      })
                    }
                  />
                )}
              </label>
            ))}
            <p>
              Активация — режим online после добавления доступных портов. Лимит
              относится только к станции.
            </p>
            <button className="button" disabled={busy}>
              Сохранить
            </button>
          </form>
        </Modal>
      )}
      {archive && (
        <Modal
          title="Архивировать объект?"
          onClose={() => !busy && setArchive(null)}
        >
          <p>
            Объект исчезнет из нового бронирования, история сохранится.
            Действующий резерв или незавершённая сессия блокируют архивирование.
          </p>
          <ErrorMessage message={error} />
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void act(() =>
                api.operatorSave(
                  `${archive.kind === "station" ? "stations" : "connectors"}/${archive.id}/archive`,
                  {},
                  "POST",
                ),
              )
            }
          >
            Подтвердить архивирование
          </button>
        </Modal>
      )}
    </AppShell>
  );
}
