import type { Session } from "../types/domain";
export const money = (value: number) =>
  new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
export const dateTime = (value: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date());
export function sessionMetrics(
  session: Session,
  battery: number,
  now = Date.now(),
) {
  const elapsed =
    session.status === "active"
      ? Math.max(
          0,
          (now - Date.parse(session.meteredAt ?? session.startedAt)) / 3600000,
        )
      : 0;
  battery = session.batteryCapacity ?? battery;
  const meteredEnergy =
    session.status === "completed"
      ? Math.max(0, session.energy)
      : Math.min(
          session.energy + elapsed * session.power,
          Math.max(
            0,
            ((session.targetCharge - session.initialCharge) / 100) * battery,
          ),
        );
  const energy = Math.round(meteredEnergy * 10) / 10;
  const charge = Math.min(
    session.status === "completed" ? 100 : session.targetCharge,
    session.initialCharge + (energy / battery) * 100,
  );
  return {
    energy,
    charge: Math.round(charge),
    amount: Math.round(energy * session.tariff),
    remaining: session.power
      ? Math.max(
          0,
          Math.ceil(
            ((((session.targetCharge - charge) / 100) * battery) /
              session.power) *
              60,
          ),
        )
      : 0,
  };
}
export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const csv =
    "\uFEFF" +
    rows
      .map((row) =>
        row
          .map(
            (cell) =>
              '"' +
              String(cell)
                .replace(/"/g, '""')
                .replace(/^[=+@-]/, "'$&") +
              '"',
          )
          .join(";"),
      )
      .join("\r\n");
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function telemetryState(session: Session, now = Date.now()) {
  if (session.status === "completed") return "completed";
  if (session.telemetry?.connection === "offline") return "offline";
  if (
    !session.telemetry ||
    now - Date.parse(session.telemetry.receivedAt) > 60000 ||
    !Number.isFinite(Date.parse(session.telemetry.receivedAt))
  )
    return "stale";
  return "online";
}

// Device readings are never extrapolated; demo readings advance only while fresh.
export function displaySessionMetrics(
  session: Session,
  battery: number,
  now = Date.now(),
) {
  const state = telemetryState(session, now);
  if (state === "completed") return sessionMetrics(session, battery, now);
  const sample = session.telemetry;
  if (!sample)
    return sessionMetrics({ ...session, status: "completed" }, battery, now);
  return sessionMetrics(
    {
      ...session,
      energy: sample.energy,
      meteredAt: sample.receivedAt,
      status:
        state === "online" && sample.source === "demo" ? "active" : "completed",
    },
    battery,
    now,
  );
}
