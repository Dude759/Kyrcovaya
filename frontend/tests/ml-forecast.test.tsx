import "./setup";
import { readFileSync } from "node:fs";
import { it, beforeEach, afterEach, vi, expect } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
vi.mock("../src/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/api")>()),
  apiMode: "http",
}));
import { api } from "../src/services/api";
import { ForecastPanel } from "../src/components/ForecastPanel";
const bundle = JSON.parse(
  readFileSync("../backend/assets/demo-forecast.json", "utf8"),
);
beforeEach(() => {
  vi.spyOn(api, "forecastStatus").mockResolvedValue({
    status: "insufficient_data",
    readiness: "NEEDS_MORE_DATA",
    source: "actual",
    forecast: null,
    reason: "Рабочая сеть NEEDS_MORE_DATA",
    quality: { completeStationHours: 0, stationHours: 912 },
  });
  vi.spyOn(api, "forecastDemo").mockResolvedValue({
    status: "ready",
    historical: true,
    staleForCurrentNetwork: true,
    forecast: bundle,
    warning: "Synthetic only",
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const show = (path = "/operator") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ForecastPanel forecast={null} networkLimit={0} />
    </MemoryRouter>,
  );
it("actual insufficiency and explicit historical experiment are separate", async () => {
  show();
  await screen.findByText("NEEDS_MORE_DATA · Недостаточно полных данных");
  expect(api.forecastDemo).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть учебный ML-эксперимент" }),
  );
  await screen.findByText(/Synthetic · исторический replay/);
  expect(screen.getByText(/2026-05-02T00:00:00Z/)).toBeTruthy();
  expect(
    screen.getByText(/Качество на реальной сети не подтверждено/),
  ).toBeTruthy();
  expect(screen.getByText("RandomForestRegressor")).toBeTruthy();
  expect(screen.getByText("Weekly baseline")).toBeTruthy();
  expect(screen.getByText("Last observation")).toBeTruthy();
  expect(screen.getAllByRole("option").length).toBe(25);
  expect(screen.queryByText(/Infinity/)).toBeNull();
});
it("historical replay survives page URL reload; source and time never become today", async () => {
  show("/operator?forecast=demo");
  await screen.findByText(/Synthetic · исторический replay/);
  expect(screen.getByText(new RegExp(bundle.modelVersion))).toBeTruthy();
  expect(screen.getByText(/Origin: 2026-05-02/)).toBeTruthy();
  expect(screen.getByText(/Устаревший для текущей сети/)).toBeTruthy();
  expect(
    screen.getByText(/Это покрытие данных, не процент точности/),
  ).toBeTruthy();
});
it("access or network errors are visible without invented forecast", async () => {
  vi.mocked(api.forecastDemo).mockRejectedValue(
    new Error("Учебный эксперимент организации не найден."),
  );
  show("/operator?forecast=demo");
  await screen.findByText("Учебный эксперимент организации не найден.");
  expect(
    screen.queryByRole("img", { name: /Прогноз нагрузки на сутки/ }),
  ).toBeNull();
  expect(
    screen.getByText("NEEDS_MORE_DATA · Недостаточно полных данных"),
  ).toBeTruthy();
});
