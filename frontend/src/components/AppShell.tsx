import type { ReactNode } from "react";
import {
  BarChart3,
  BatteryCharging,
  CalendarDays,
  CircleUserRound,
  Gauge,
  MapPin,
  Settings2,
  SlidersHorizontal,
  LogOut,
} from "lucide-react";
import { Link } from "react-router-dom";
import { BrandMark } from "./BrandMark";
import { useApp } from "../state/context";
import { useAction } from "../hooks/useAction";
import { apiMode } from "../services/api";

export type Role = "driver" | "operator";
export type NavigationKey =
  | "stations"
  | "sessions"
  | "bookings"
  | "profile"
  | "power"
  | "analytics"
  | "settings";

type AppShellProps = {
  role: Role;
  active: NavigationKey;
  title: string;
  subtitle: string;
  children: ReactNode;
};

const driverItems = [
  { key: "stations", label: "Станции", to: "/driver/stations", icon: MapPin },
  {
    key: "sessions",
    label: "Сессии",
    to: "/driver/sessions",
    icon: BatteryCharging,
  },
  {
    key: "bookings",
    label: "Брони",
    to: "/driver/bookings",
    icon: CalendarDays,
  },
  {
    key: "profile",
    label: "Профиль",
    to: "/driver/profile",
    icon: CircleUserRound,
  },
  {
    key: "settings",
    label: "Настройки",
    to: "/driver/settings",
    icon: Settings2,
  },
] as const;

const operatorItems = [
  { key: "stations", label: "Станции", to: "/operator/stations", icon: MapPin },
  { key: "sessions", label: "Сессии", to: "/operator/sessions", icon: Gauge },
  {
    key: "power",
    label: "Мощность",
    to: "/operator/power",
    icon: SlidersHorizontal,
  },
  { key: "analytics", label: "Аналитика", to: "/operator", icon: BarChart3 },
  {
    key: "settings",
    label: "Настройки",
    to: "/operator/settings",
    icon: Settings2,
  },
] as const;

export function AppShell({
  role,
  active,
  title,
  subtitle,
  children,
}: AppShellProps) {
  const { user, logout, error, refresh } = useApp();
  const action = useAction();
  const items = role === "operator" ? operatorItems : driverItems;
  const name = user?.name ?? "Гость";
  const person = {
    name,
    label: role === "operator" ? "Оператор" : "Водитель",
    initials: name
      .split(" ")
      .map((part) => part[0])
      .slice(0, 2)
      .join(""),
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link
          className="sidebar__brand"
          to={role === "operator" ? "/operator" : "/driver/stations"}
        >
          <BrandMark size={48} tone="green" />
          <span className="sr-only">Энерготранспорт</span>
        </Link>
        <nav className="sidebar__nav" aria-label={`Навигация: ${person.label}`}>
          {items.map(({ key, label, to, icon: Icon }) => (
            <Link
              key={key}
              to={to}
              className={`sidebar__item ${active === key ? "is-active" : ""}`}
              aria-current={active === key ? "page" : undefined}
            >
              <Icon size={21} strokeWidth={1.8} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div
          className="sidebar__avatar"
          title={`${person.name}, ${person.label}`}
        >
          {person.initials}
        </div>
      </aside>

      <header className="topbar">
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="topbar__meta">
          <span>Москва</span>
          {apiMode === "mock" && (
            <span
              className="demo-badge"
              title="Данные сохраняются локально. Платежи тестовые."
            >
              Демо
            </span>
          )}
          <span className="topbar__profile" aria-hidden="true">
            {person.initials}
          </span>
          <span className="topbar__person">
            <strong>{person.name}</strong>
            <small>{person.label}</small>
          </span>
          <button
            className="logout-button"
            title="Выйти из аккаунта"
            aria-label="Выйти из аккаунта"
            disabled={action.busy}
            onClick={() => void action.run(logout)}
          >
            <LogOut size={19} />
          </button>
        </div>
      </header>

      <main className="app-content">
        {error && (
          <div className="connection-banner" role="alert">
            <span>
              Не удалось обновить данные. Показаны последние сохранённые
              значения. {error}
            </span>
            <button
              className="button button--outline"
              disabled={action.busy}
              onClick={() => void action.run(refresh)}
            >
              Повторить обновление
            </button>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
