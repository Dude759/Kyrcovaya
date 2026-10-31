import "./setup";
import { it, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  PowerDispatchPanel,
  type DispatchView,
} from "../src/components/PowerDispatchPanel";
import { api } from "../src/services/api";
let data: DispatchView;
beforeEach(() => {
  data = {
    enabled: false,
    source: "simulator",
    status: "off",
    withinBudget: null,
    acknowledgedW: 0,
    grid: {
      budgetW: 400000,
      validity: "fresh",
      asOf: new Date().toISOString(),
      freshnessSeconds: 60,
      reading: { receivedAt: new Date().toISOString() },
    },
    sessions: [],
    history: [],
  };
  vi.spyOn(api, "powerDispatch").mockImplementation(async () =>
    structuredClone(data),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("starts OFF and controlled enable uses server API with stable key after lost response", async () => {
  const post = vi
    .spyOn(api, "setPowerDispatch")
    .mockRejectedValue(new Error("Ответ потерян"));
  render(<PowerDispatchPanel />);
  await screen.findByText("Выключено");
  const button = screen.getByRole("button", {
    name: "Включить управление имитаторами",
  });
  fireEvent.click(button);
  await screen.findByText("Ответ потерян");
  fireEvent.click(button);
  await screen.findByText("Ответ потерян");
  expect(post).toHaveBeenCalledTimes(2);
  expect(post.mock.calls[0][0]).toBe(true);
  expect(post.mock.calls[0][1]).toBe(post.mock.calls[1][1]);
});
it("pending command is separate from acknowledged and measured power; existing sessions block mode switching", async () => {
  data.enabled = true;
  data.status = "degraded";
  data.withinBudget = false;
  data.acknowledgedW = 22000;
  data.grid.budgetW = 10000;
  data.sessions = [
    {
      id: "session-1",
      stationId: "Учебная станция",
      status: "active",
      requestedW: 22000,
      plannedW: 10000,
      acknowledgedW: 22000,
      measuredW: 21500,
      effectiveAt: new Date().toISOString(),
      managed: true,
      reconciliation: "pending",
      command: {
        id: "command",
        targetW: 10000,
        status: "submitted",
        confirmedAt: null,
        reason: null,
      },
    },
  ];
  render(<PowerDispatchPanel />);
  await screen.findByText("Учебная станция");
  expect(screen.getByText("Отправлена устройству")).toBeTruthy();
  expect(screen.getByText("21.500 кВт")).toBeTruthy();
  expect(
    screen.getByText("Переходное превышение или неполные показания"),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Выключить управление",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getAllByText("22.000 кВт").length).toBeGreaterThan(1);
  expect(screen.getAllByText("10.000 кВт").length).toBeGreaterThan(1);
});
it("unknown Grid never becomes zero or positive budget; zero acknowledgement remains a real pause", async () => {
  data.enabled = true;
  data.status = "degraded";
  data.grid.budgetW = null;
  data.grid.validity = "offline";
  data.sessions = [
    {
      id: "s",
      stationId: "Пауза",
      status: "active",
      requestedW: 22000,
      plannedW: 0,
      acknowledgedW: 0,
      measuredW: null,
      effectiveAt: new Date().toISOString(),
      managed: true,
      reconciliation: "acknowledged",
      command: {
        id: "c",
        targetW: 0,
        status: "acknowledged",
        confirmedAt: new Date().toISOString(),
        reason: null,
      },
    },
  ];
  render(<PowerDispatchPanel />);
  await screen.findByText("Пауза");
  expect(screen.getByText("Grid неизвестен: запрошена пауза")).toBeTruthy();
  expect(screen.getAllByText("0.000 кВт").length).toBeGreaterThan(1);
  expect(screen.getAllByText("Нет достоверных данных").length).toBeGreaterThan(
    1,
  );
});
it("historical graph distinguishes calculated and confirmed values and rejection is visible", async () => {
  data.enabled = true;
  data.status = "rejected";
  data.history = [
    {
      id: "p",
      created_at: new Date().toISOString(),
      budget_w: "20000",
      planned_w: "20000",
      acknowledged_w: "44000",
    },
  ];
  render(<PowerDispatchPanel />);
  await screen.findByText("Норма → дефицит → восстановление");
  expect(screen.getByText("Подтверждено на момент расчёта")).toBeTruthy();
  expect(
    screen.getByText("Отказ устройства / устаревшая команда"),
  ).toBeTruthy();
  expect(screen.getByTitle("planned: 20.000 кВт")).toBeTruthy();
  expect(screen.getByTitle("confirmed: 44.000 кВт")).toBeTruthy();
});
