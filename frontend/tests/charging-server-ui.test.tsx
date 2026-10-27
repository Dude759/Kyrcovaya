import "./setup";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Context, type AppState } from "../src/state/context";
import { ServerChargingPage } from "../src/pages/ServerChargingPage";
import { api } from "../src/services/api";
import { stations } from "../src/data";
import { displaySessionMetrics } from "../src/utils/format";
import type { Session } from "../src/types/domain";
vi.mock("../src/services/api", async (original) => ({
  ...(await original<typeof import("../src/services/api")>()),
  apiMode: "http",
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    },
    close: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    },
  });
});
function fixture(): Session {
  return {
    id: "session",
    userId: "driver",
    bookingId: "booking",
    stationId: stations[0].id,
    connector: "CCS2",
    connectorId: "physical-port",
    startedAt: new Date().toISOString(),
    startConfirmedAt: new Date().toISOString(),
    meteredAt: new Date().toISOString(),
    batteryCapacity: 75,
    endedAt: null,
    energy: 0.123,
    energyWh: 123,
    power: 22,
    currentPowerKw: 22,
    initialCharge: null,
    targetCharge: null,
    tariff: 18,
    tariffKopecks: 1800,
    prepaidKopecks: 40500,
    energyBudgetWh: 22500,
    costKopecks: 222,
    status: "active",
    source: "simulator",
    soc: null,
    telemetry: {
      source: "simulator",
      receivedAt: new Date().toISOString(),
      connection: "online",
      energy: 0.123,
    },
  };
}
function show(value = fixture()) {
  vi.spyOn(api, "session").mockResolvedValue(value);
  const state: AppState = {
    user: {
      id: "driver",
      role: "driver",
      name: "Водитель",
      email: "driver@example.test",
      phone: "",
    },
    data: {
      stage: "bookings",
      charging: true,
      stations,
      sessions: [value],
      bookings: [],
      payments: [],
      events: [],
      forecast: null,
      networkLimit: 0,
      organization: "",
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
    refresh: vi.fn(async () => {}),
    authenticate: async () => {},
    logout: async () => {},
    mutate: async (op) => op(),
    notify: () => {},
  };
  return render(
    <MemoryRouter initialEntries={["/driver/charging?session=session"]}>
      <Context.Provider value={state}>
        <ServerChargingPage />
      </Context.Provider>
    </MemoryRouter>,
  );
}
it("shows simulator readings and unknown SOC without a fabricated battery percentage", async () => {
  show();
  await screen.findByRole("heading", { name: "Зарядка идёт" });
  expect(screen.getByText("0.123 кВт⋅ч")).toBeTruthy();
  expect(screen.getByText(/нет измерения SOC/)).toBeTruthy();
  expect(screen.queryByText(/расчётный заряд батареи/)).toBeNull();
  expect(
    screen.getByText(/Реальная зарядная станция не подключена/),
  ).toBeTruthy();
});
it("starting remains explicitly unconfirmed and does not show active power", async () => {
  show({
    ...fixture(),
    status: "starting",
    startConfirmedAt: null,
    telemetry: undefined,
    currentPowerKw: null,
    energy: 0,
    energyWh: 0,
  });
  await screen.findByRole("heading", { name: "Ожидаем подтверждения запуска" });
  expect(screen.getByText(/Начало зарядки ещё не подтверждено/)).toBeTruthy();
  expect(screen.queryByText("22 кВт")).toBeNull();
});
it("readings older than sixty seconds preserve energy but hide current power", async () => {
  show({
    ...fixture(),
    telemetry: {
      ...fixture().telemetry!,
      receivedAt: new Date(Date.now() - 61000).toISOString(),
    },
  });
  await screen.findByText("0.123 кВт⋅ч");
  expect(screen.queryByText("22 кВт")).toBeNull();
  expect(screen.getByText(/Текущая мощность неизвестна/)).toBeTruthy();
});
it("server energy is never advanced by client clock or changed battery profile", () => {
  const sample = fixture();
  const a = displaySessionMetrics(sample, 75, Date.now()),
    b = displaySessionMetrics(sample, 250, Date.now() + 3600000);
  expect(a.energy).toBe(0.123);
  expect(b.energy).toBe(a.energy);
  expect(b.amount).toBe(2.22);
});
it("stopping cannot masquerade as completed or show a final settlement before acknowledgement", async () => {
  show({ ...fixture(), status: "stopping" });
  await screen.findByRole("heading", {
    name: "Ожидаем подтверждения остановки",
  });
  expect(screen.getByText(/итог ещё не зафиксирован/)).toBeTruthy();
  expect(screen.queryByText("Окончательная стоимость")).toBeNull();
});
function completed(status: "submitted" | "succeeded"): Session {
  return {
    ...fixture(),
    status: "completed",
    endedAt: new Date().toISOString(),
    currentPowerKw: null,
    settlement: {
      id: "settlement",
      energyWh: 123,
      tariffKopecks: 1800,
      prepaidKopecks: 40500,
      finalCostKopecks: 222,
      unusedKopecks: 40278,
      reason: "user",
      source: "simulator",
      createdAt: new Date().toISOString(),
    },
    refund: {
      id: "refund",
      amountKopecks: 40278,
      status,
      confirmedAt: status === "succeeded" ? new Date().toISOString() : null,
      test: true,
    },
  };
}
it("completed energy billing uses integer kopecks and pending refund stays unconfirmed", async () => {
  show(completed("submitted"));
  await screen.findByRole("heading", { name: "Зарядка завершена" });
  expect(screen.getByText("Окончательная стоимость")).toBeTruthy();
  expect(screen.getByText(/2,22/)).toBeTruthy();
  expect(screen.getByText(/Возврат остатка ожидается/)).toBeTruthy();
  expect(screen.queryByText(/Тестовый возврат подтверждён/)).toBeNull();
});
it("confirmed refund is displayed only with final adapter confirmation", async () => {
  show(completed("succeeded"));
  await screen.findByRole("heading", { name: "Зарядка завершена" });
  expect(screen.getByText(/Тестовый возврат подтверждён/)).toBeTruthy();
  expect(screen.queryByText(/Возврат остатка ожидается/)).toBeNull();
});
it("retries stop with the same key and waits for simulator instead of announcing completion", async () => {
  show();
  await screen.findByRole("heading", { name: "Зарядка идёт" });
  const stop = vi
    .spyOn(api, "stop")
    .mockRejectedValueOnce(new Error("Ответ потерян"))
    .mockResolvedValue({ ...fixture(), status: "stopping" });
  fireEvent.click(screen.getByRole("button", { name: "Остановить зарядку" }));
  fireEvent.click(screen.getByRole("button", { name: "Запросить остановку" }));
  await screen.findByText("Ответ потерян");
  vi.mocked(api.session).mockResolvedValue({
    ...fixture(),
    status: "stopping",
  });
  fireEvent.click(screen.getByRole("button", { name: "Запросить остановку" }));
  await screen.findByRole("heading", {
    name: "Ожидаем подтверждения остановки",
  });
  await waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
  expect(stop.mock.calls[0][1]).toBe(stop.mock.calls[1][1]);
  expect(
    screen.queryByRole("heading", { name: "Зарядка завершена" }),
  ).toBeNull();
});
