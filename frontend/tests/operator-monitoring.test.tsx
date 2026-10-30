import "./setup";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  within,
  fireEvent,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { OperatorMonitoringPage } from "../src/pages/OperatorMonitoringPage";
import { Context, type AppState } from "../src/state/context";
import { api } from "../src/services/api";
import { sessionCsvRows, historyCsvRows } from "../src/utils/monitoring-csv";
import * as format from "../src/utils/format";
import type {
  MonitoringSnapshot,
  MonitoringSession,
  PowerHistory,
} from "../src/types/monitoring";
let snapshot: MonitoringSnapshot,
  session: MonitoringSession,
  history: PowerHistory;
beforeEach(() => {
  const now = new Date().toISOString();
  session = {
    id: "session",
    stationId: "station",
    stationName: "Учебная станция",
    connectorId: "port",
    connectorLabel: "Порт A",
    connectorType: "CCS2",
    status: "active",
    requestedAt: now,
    startedAt: now,
    endedAt: null,
    allocatedPowerW: 22000,
    currentPowerW: 7000,
    lastPowerW: 7000,
    knownEnergyWh: 79,
    lastMeasuredAt: now,
    ageSeconds: 0,
    telemetry: "fresh",
    gap: false,
    telemetryGap: false,
    source: "simulator",
    finalCostKopecks: null,
  };
  snapshot = {
    asOf: now,
    source: "simulator",
    scope: "simulated_charging_sessions",
    gridBudgetKw: null,
    gridReserveKw: null,
    sessionCounts: {
      starting: 0,
      active: 1,
      stopping: 0,
      completed: 0,
      failed: 0,
    },
    knownEnergyWh: 79,
    completedTestCostKopecks: 143,
    measuredPowerW: null,
    measuredSubsetPowerW: 7000,
    measuredSessions: 1,
    expectedSessions: 2,
    complete: false,
    allocatedPowerW: 44000,
    telemetryCounts: { fresh: 1, missing: 1, stale: 0, offline: 0 },
    stations: [],
    sessions: [session],
  };
  history = {
    stationId: "station",
    stationName: "Учебная станция",
    intervalStart: now,
    intervalEnd: now,
    measuredEnergyWh: null,
    averagePowerW: null,
    measuredSubsetAverageW: null,
    activeSessions: 1,
    localLimitKw: 100,
    source: "simulator",
    quality: "missing",
    observedMs: 0,
    coveredSessionMs: 0,
    expectedSessionMs: 3600000,
    sampleCount: 0,
    gapCount: 0,
    boundaryCount: 0,
    unattributedEnergyWh: 0,
    firstSampleAt: null,
    lastSampleAt: null,
    builtAt: now,
    rule: "strict-adjacent-v1",
  };
  vi.spyOn(api, "operatorMonitoring").mockImplementation(async () => snapshot);
  vi.spyOn(api, "operatorSessions").mockImplementation(async () => ({
    items: [session],
    nextCursor: null,
  }));
  vi.spyOn(api, "operatorHistory").mockImplementation(async () => ({
    items: [history],
    nextCursor: null,
  }));
  vi.spyOn(api, "operatorTechnicalEvents").mockResolvedValue({
    items: [],
    nextCursor: null,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function show() {
  render(
    <MemoryRouter>
      <Context.Provider
        value={{ refresh: vi.fn(async () => {}) } as unknown as AppState}
      >
        <OperatorMonitoringPage />
      </Context.Provider>
    </MemoryRouter>,
  );
}
it("unknown full load is not replaced by known subset or allocated power", async () => {
  show();
  await screen.findByText("Стоимость завершённых тестовых зарядок");
  expect(screen.getByText("Полная текущая нагрузка неизвестна")).toBeTruthy();
  expect(
    screen.getByText("1 из 2 незавершённых сессий · simulator"),
  ).toBeTruthy();
  expect(
    screen.getByText("Выделено имитатору", { selector: "span" }),
  ).toBeTruthy();
  expect(screen.queryByText("Выручка")).toBeNull();
  expect(screen.queryByText(/Резерв 0 кВт/)).toBeNull();
});
it("missing interval chart is a gap, not a zero load point", async () => {
  show();
  const chart = await screen.findByRole("img", { name: /Почасовая нагрузка/ });
  expect(within(chart).getByText("?")).toBeTruthy();
  expect(within(chart).getByText("Нет данных")).toBeTruthy();
  expect(historyCsvRows([history])[1][6]).toBe("");
  expect(historyCsvRows([history])[1][7]).toBe("");
});
it("pending stop stays separate from completed session and final settlement", async () => {
  session.status = "stopping";
  session.endedAt = null;
  session.finalCostKopecks = null;
  vi.mocked(api.operatorTechnicalEvents).mockResolvedValue({
    items: [
      {
        id: "stop",
        stationId: "station",
        sessionId: "session",
        at: snapshot.asOf,
        kind: "stop",
        status: "submitted",
      },
    ],
    nextCursor: null,
  });
  show();
  await screen.findByText(/Команда остановки · Ожидает подтверждения/);
  expect(screen.getByText("Расчёт не завершён")).toBeTruthy();
  expect(screen.getByText("Не подтверждено")).toBeTruthy();
});
it("CSV uses the same received page, raw Wh/W/kopecks and source without driver identity", async () => {
  session.status = "completed";
  session.currentPowerW = null;
  session.finalCostKopecks = 143;
  const csv = vi.spyOn(format, "downloadCsv").mockImplementation(() => {});
  show();
  await screen.findByText("CSV сессий этой страницы");
  fireEvent.click(
    screen.getByRole("button", { name: "CSV сессий этой страницы" }),
  );
  expect(csv).toHaveBeenCalledWith(
    "simulator-sessions.csv",
    sessionCsvRows([session]),
  );
  const row = sessionCsvRows([session])[1];
  expect(row[7]).toBe("");
  expect(row[8]).toBe(22000);
  expect(row[9]).toBe(79);
  expect(row[10]).toBe(143);
  expect(row).not.toContain("userId");
  expect(screen.getAllByText(/1,43/).length).toBeGreaterThan(0);
});
it("stale response does not keep an old power value looking current", async () => {
  snapshot.asOf = new Date(Date.now() - 61000).toISOString();
  session.ageSeconds = 61;
  session.telemetry = "stale";
  session.currentPowerW = null;
  show();
  await screen.findByText(/Показания устарели/);
  expect(screen.getByText("Старше 60 секунд")).toBeTruthy();
  expect(screen.queryByText("7.000 кВт")).toBeNull();
});
it("filters use server query and page controls do not invent more data", async () => {
  show();
  await screen.findByLabelText("Статус сессии");
  fireEvent.change(screen.getByLabelText("Статус сессии"), {
    target: { value: "failed" },
  });
  await vi.waitFor(() =>
    expect(api.operatorSessions).toHaveBeenLastCalledWith(
      expect.stringContaining("status=failed"),
    ),
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Следующие сессии",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
