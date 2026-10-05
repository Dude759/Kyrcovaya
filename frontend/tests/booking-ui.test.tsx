import "./setup";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { stations } from "../src/data";
import { Context } from "../src/state/context";
import type { AppState } from "../src/state/context";
import { BookingPage } from "../src/pages/ChargingPages";
import { DriverMapPage } from "../src/pages/StationsPages";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function fixture(children: ReactNode, objects = stations) {
  const value: AppState = {
    user: {
      id: "driver",
      role: "driver",
      name: "Водитель",
      email: "driver@example.test",
      phone: "+7 999 0000000",
      vehicle: "Zeekr 001",
      plate: "",
      connector: "CCS2",
      battery: 100,
    },
    data: {
      stations: objects,
      bookings: [],
      sessions: [],
      preferences: {
        bookingAlerts: true,
        receipts: true,
        networkAlerts: false,
        criticalAlerts: true,
        loadAlerts: true,
        reports: false,
      },
      networkLimit: 6000,
      organization: "Организация",
      events: [],
      forecast: null,
    },
    loading: false,
    error: "",
    refresh: async () => {},
    authenticate: async () => {},
    logout: async () => {},
    mutate: (operation) => operation(),
    notify: () => {},
  };
  return render(
    <MemoryRouter initialEntries={["/driver/booking?station=khodynka"]}>
      <Context.Provider value={value}>{children}</Context.Provider>
    </MemoryRouter>,
  );
}
it("после полуночи предлагает правильную дату, сохраняя выбранную станцию и тариф", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T20:58:00Z"));
  fixture(<BookingPage />);
  expect((screen.getByLabelText("Дата") as HTMLInputElement).value).toBe(
    "2026-10-06",
  );
  expect((screen.getByLabelText("Начало") as HTMLInputElement).value).toBe(
    "00:03",
  );
  expect(screen.getByText("Заряд Ходынка")).toBeTruthy();
  expect(screen.getByText("16 ₽/кВт⋅ч")).toBeTruthy();
});
it("фильтр свободных CCS2 не показывает станцию, где свободен только Type 2", () => {
  const station = structuredClone(stations[0]);
  station.connectors.forEach((c) => {
    c.available = c.type === "Type 2" ? 1 : 0;
  });
  fixture(<DriverMapPage />, [station]);
  fireEvent.change(screen.getByLabelText("Тип разъёма"), {
    target: { value: "CCS2" },
  });
  expect(screen.getByText("Найдено станций: 0")).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Станции не найдены" }),
  ).toBeTruthy();
});
