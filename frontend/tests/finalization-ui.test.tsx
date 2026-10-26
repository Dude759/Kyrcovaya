import "./setup";
import { afterEach, it, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Context, type AppState } from "../src/state/context";
import { CheckoutPage } from "../src/pages/CheckoutPage";
import { BookingsPage } from "../src/pages/ChargingPages";
import { api } from "../src/services/api";
import { stations } from "../src/data";
import type { Payment, Booking } from "../src/types/domain";
vi.mock("../src/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/api")>()),
  apiMode: "http",
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const booking: Booking = {
  id: "booking",
  userId: "driver",
  stationId: stations[0].id,
  connector: "CCS2",
  connectorId: "00000000-0000-4000-8000-000000000123",
  paymentId: "payment",
  reservationId: "reservation",
  start: new Date(Date.now() + 3600000).toISOString(),
  duration: 30,
  amount: 405,
  payment: "card",
  status: "confirmed",
  createdAt: new Date().toISOString(),
};
const basePayment: Payment = {
  id: "payment",
  userId: "driver",
  input: {
    stationId: booking.stationId,
    connector: "CCS2",
    start: booking.start,
    duration: 30,
    payment: "card",
  },
  amount: 405,
  status: "succeeded",
  bookingId: "booking",
  createdAt: booking.createdAt,
  expiresAt: booking.start,
  failure: null,
  test: true,
  providerSuccessReceived: true,
};
function show(
  payment = basePayment,
  bookings: Booking[] = [booking],
  networkError = false,
) {
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
      stations,
      bookings,
      sessions: [],
      payments: [payment],
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
  const read = vi.spyOn(api, "payment").mockResolvedValue(payment);
  if (networkError) read.mockRejectedValueOnce(new Error("Связь потеряна"));
  return render(
    <MemoryRouter initialEntries={["/driver/checkout/payment"]}>
      <Context.Provider value={state}>
        <Routes>
          <Route
            path="/driver/checkout/:paymentId"
            element={<CheckoutPage />}
          />
          <Route path="/driver/bookings" element={<BookingsPage />} />
        </Routes>
      </Context.Provider>
    </MemoryRouter>,
  );
}
it("HTTP checkout redirects to bookings and exposes exact physical port without charging controls", async () => {
  show();
  await screen.findByRole("heading", { name: "Мои бронирования" });
  expect(screen.getByText("Подтверждена")).toBeTruthy();
  expect(screen.getByText(/00000000-0000-4000-8000-000000000123/)).toBeTruthy();
  expect(screen.getByText("405 ₽", { exact: false })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Начать зарядку" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Отменить бронь" })).toBeNull();
});
it("reopening checkout after refresh still returns the existing confirmed booking", async () => {
  const first = show();
  await screen.findByText("Подтверждена");
  first.unmount();
  show();
  await screen.findByText("Подтверждена");
  expect(screen.getAllByText("Подтверждена")).toHaveLength(1);
});
it("submitted refund is explicitly not completed before adapter confirmation", async () => {
  show(
    {
      ...basePayment,
      status: "failed",
      bookingId: null,
      reconciliationRequired: true,
      refunds: [
        {
          id: "refund",
          status: "submitted",
          reason: "hold_expired",
          amount: 405,
          confirmedAt: null,
          test: true,
        },
      ],
    },
    [],
  );
  await screen.findByRole("heading", {
    name: "Тестовый результат требует сверки",
  });
  expect(screen.getByText(/возврат не выполнен/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Повторить оплату" })).toBeNull();
  expect(screen.queryByText("Тестовый возврат подтверждён")).toBeNull();
});
it("only a confirmed adapter receipt displays completed test refund", async () => {
  show(
    {
      ...basePayment,
      status: "failed",
      bookingId: null,
      reconciliationRequired: false,
      refunds: [
        {
          id: "refund",
          status: "succeeded",
          reason: "hold_expired",
          amount: 405,
          confirmedAt: new Date().toISOString(),
          test: true,
        },
      ],
    },
    [],
  );
  await screen.findByRole("heading", { name: "Тестовый возврат подтверждён" });
  expect(screen.getByText(/адаптер подтвердил возврат/)).toBeTruthy();
});
it("network error retries reading the same order rather than creating a second payment", async () => {
  show(basePayment, [booking], true);
  await screen.findByText("Связь потеряна");
  fireEvent.click(screen.getByRole("button", { name: "Проверить ещё раз" }));
  await screen.findByText("Подтверждена");
  expect(
    vi.mocked(api.payment).mock.calls.every(([id]) => id === "payment"),
  ).toBe(true);
});
