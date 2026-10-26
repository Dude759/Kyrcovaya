import "./setup";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { CheckoutPage } from "../src/pages/CheckoutPage";
import { Context, type AppState } from "../src/state/context";
import { api } from "../src/services/api";
import type { Payment } from "../src/types/domain";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const state: AppState = {
  user: {
    id: "driver",
    name: "Водитель",
    email: "fixture@example.test",
    phone: "",
    role: "driver",
  },
  data: {
    stage: "foundation",
    stations: [],
    bookings: [],
    sessions: [],
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
  refresh: async () => {},
  authenticate: async () => {},
  logout: async () => {},
  mutate: async (op) => op(),
  notify: () => {},
};
function fixture(): Payment {
  return {
    id: "p",
    userId: "driver",
    input: {
      stationId: "station",
      connector: "CCS2",
      start: new Date(Date.now() + 86400000).toISOString(),
      duration: 60,
      payment: "card",
    },
    amount: 405,
    status: "pending",
    bookingId: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    failure: null,
    test: true,
    providerSuccessReceived: true,
    awaitingFinalization: true,
  };
}
function show(p: Payment) {
  vi.spyOn(api, "payment").mockResolvedValue(p);
  render(
    <MemoryRouter initialEntries={["/driver/checkout/p"]}>
      <Context.Provider value={state}>
        <Routes>
          <Route
            path="/driver/checkout/:paymentId"
            element={<CheckoutPage />}
          />
        </Routes>
      </Context.Provider>
    </MemoryRouter>,
  );
}
it("не выдаёт provider success за подтверждённую оплату/бронь и скрывает повтор/отмену", async () => {
  show(fixture());
  expect(
    await screen.findByRole("heading", { name: "Результат провайдера принят" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "Оплата подтверждена" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Отменить оплату" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Повторить оплату" })).toBeNull();
  expect(screen.getByText(/Подтверждённая бронь ещё не создана/)).toBeTruthy();
});
it("при истечении после provider success показывает сверку без предложения оплатить заново", async () => {
  show({
    ...fixture(),
    expiresAt: new Date(Date.now() - 60000).toISOString(),
    status: "failed",
    reconciliationRequired: true,
  });
  expect(
    await screen.findByRole("heading", {
      name: "Тестовый результат требует сверки",
    }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Повторить оплату" })).toBeNull();
});
