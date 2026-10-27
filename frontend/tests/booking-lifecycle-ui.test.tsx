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
import { BookingsPage } from "../src/pages/ChargingPages";
import { api } from "../src/services/api";
import { stations } from "../src/data";
import type { Booking } from "../src/types/domain";
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
function fixture(extra: Partial<Booking> = {}): Booking {
  return {
    id: "booking",
    userId: "driver",
    stationId: stations[0].id,
    connector: "CCS2",
    start: new Date(Date.now() + 60000).toISOString(),
    duration: 30,
    amount: 405,
    payment: "card",
    status: "confirmed",
    createdAt: new Date().toISOString(),
    sessionId: null,
    ...extra,
  };
}
function show(b = fixture()) {
  const refresh = vi.fn(async () => {});
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
      bookings: [b],
      payments: [],
      sessions: [],
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
    refresh,
    authenticate: async () => {},
    logout: async () => {},
    mutate: async (op) => {
      const v = await op();
      await refresh();
      return v;
    },
    notify: () => {},
  };
  render(
    <MemoryRouter>
      <Context.Provider value={state}>
        <BookingsPage />
      </Context.Provider>
    </MemoryRouter>,
  );
  return refresh;
}
it("HTTP cancellation requires confirmation and explains full test refund policy", async () => {
  const spy = vi
    .spyOn(api, "cancel")
    .mockResolvedValue(fixture({ status: "cancelled" }));
  const refresh = show();
  fireEvent.click(screen.getByRole("button", { name: "Отменить бронь" }));
  expect(spy).not.toHaveBeenCalled();
  expect(
    screen.getByText(/вся тестовая предоплата будет возвращена/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить отмену" }));
  await waitFor(() => expect(spy).toHaveBeenCalledWith("booking"));
  expect(refresh).toHaveBeenCalled();
});
it("starting session cannot be cancelled and opens its server session instead", () => {
  show(fixture({ sessionId: "session", sessionStatus: "starting" }));
  expect(screen.queryByRole("button", { name: "Отменить бронь" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Начать зарядку" })).toBeNull();
  expect(
    screen.getByRole("link", { name: "Открыть сессию" }).getAttribute("href"),
  ).toContain("session=session");
});
it("failed historical session never gets a second cancellation action", () => {
  show(
    fixture({
      status: "cancelled",
      closureReason: "session",
      sessionId: "failed-session",
      sessionStatus: "failed",
    }),
  );
  expect(screen.getByText("Завершена без запуска")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Отменить бронь" })).toBeNull();
});
it("driver cancellation distinguishes submitted refund from confirmed receipt", () => {
  show(
    fixture({
      status: "cancelled",
      closureReason: "driver",
      refund: {
        id: "refund",
        amountKopecks: 40500,
        status: "submitted",
        confirmedAt: null,
        test: true,
      },
    }),
  );
  expect(screen.getByText("Отменена водителем")).toBeTruthy();
  expect(screen.getByText(/Тестовый возврат ожидается/)).toBeTruthy();
  expect(screen.queryByText(/возврат подтверждён/)).toBeNull();
});
it("expired no-show and confirmed refund survive rendering history from server snapshot", () => {
  show(
    fixture({
      status: "expired",
      closureReason: "no_show",
      refund: {
        id: "refund",
        amountKopecks: 40500,
        status: "succeeded",
        confirmedAt: new Date().toISOString(),
        test: true,
      },
    }),
  );
  expect(screen.getByText("Истекла из-за неявки")).toBeTruthy();
  expect(screen.getByText(/Тестовый возврат подтверждён/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Неявка" }));
  expect(screen.getByText("Истекла из-за неявки")).toBeTruthy();
});
it("network failure keeps cancellation dialog open and allows an idempotent retry", async () => {
  const spy = vi
    .spyOn(api, "cancel")
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValue(fixture({ status: "cancelled" }));
  show();
  fireEvent.click(screen.getByRole("button", { name: "Отменить бронь" }));
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить отмену" }));
  await waitFor(() =>
    expect(screen.getAllByText("network").length).toBeGreaterThan(0),
  );
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить отмену" }));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
});
