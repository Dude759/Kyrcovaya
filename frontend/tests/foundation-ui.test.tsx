import "./setup";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Context } from "../src/state/context";
import type { AppState } from "../src/state/context";
import {
  OperatorStationsPage,
  OperatorDashboardPage,
} from "../src/pages/OperatorPages";
import { StationMap } from "../src/components/StationMap";
import { StationCard } from "../src/components/StationCard";
import type { Station } from "../src/data";

afterEach(cleanup);
function fixture(child: React.ReactNode) {
  const value: AppState = {
    user: {
      id: "operator-db",
      name: "Оператор без автомобиля",
      email: "operator@example.test",
      phone: "",
      role: "operator",
    },
    data: {
      stage: "foundation",
      stations: [],
      bookings: [],
      sessions: [],
      payments: [],
      events: [],
      forecast: null,
      networkLimit: 100,
      organization: "Новая организация",
      preferences: {
        bookingAlerts: true,
        receipts: true,
        networkAlerts: false,
        criticalAlerts: true,
        loadAlerts: true,
        reports: false,
      },
    },
    loading: false,
    error: "",
    refresh: async () => {},
    authenticate: async () => {},
    logout: async () => {},
    mutate: async (operation) => operation(),
    notify: vi.fn(),
  };
  return render(
    <MemoryRouter>
      <Context.Provider value={value}>{child}</Context.Provider>
    </MemoryRouter>,
  );
}
it("оператор без автомобиля и станций получает пустое состояние", () => {
  fixture(<OperatorStationsPage />);
  expect(screen.getByText("Станций пока нет")).toBeTruthy();
});
it("отсутствие телеметрии не превращается в нулевую мощность или резерв", () => {
  fixture(<OperatorDashboardPage />);
  expect(screen.getByText("Нет измерений мощности")).toBeTruthy();
  expect(screen.queryByText("0.00 МВт")).toBeNull();
  expect(screen.getByText("Нет измерений")).toBeTruthy();
});
it("резервная схема показывает все серверные станции, включая неизвестные локальному seed", () => {
  vi.stubEnv("VITE_YANDEX_MAPS_API_KEY", "");
  const stations: Station[] = Array.from({ length: 10 }, (_, i) => ({
    id: `postgres-${i}`,
    name: `Станция БД ${i}`,
    address: "Учебный адрес",
    district: "Район",
    coordinates: [37.5 + i * 0.01, 55.7 + i * 0.01],
    status: "available",
    loadPercent: null,
    limitKw: 100,
    pricePerKwh: 18,
    connectors: [],
  }));
  try {
    render(
      <MemoryRouter>
        <StationMap stations={stations} />
        <StationCard station={stations[0]} />
      </MemoryRouter>,
    );
    expect(
      screen.getAllByRole("button", { name: /Выбрать станцию Станция БД/ }),
    ).toHaveLength(10);
    expect(screen.queryByText(/Infinity/)).toBeNull();
  } finally {
    vi.unstubAllEnvs();
  }
});
