import "./setup";
import { it, beforeEach, afterEach, vi, expect } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  GridPlanningPanel,
  type GridPlan,
} from "../src/components/GridPlanningPanel";
import { api } from "../src/services/api";
let data: GridPlan;
beforeEach(() => {
  data = {
    grid: {
      scenario: "deficit",
      workload: "training",
      sampleId: "1",
      version: "1",
      asOf: new Date().toISOString(),
      operatorLimitW: 4000000,
      budgetW: 150000,
      validity: "fresh",
      freshnessSeconds: 60,
      mode: "shadow",
      reading: {
        availablePowerKw: 250,
        baseLoadKw: 100,
        receivedAt: new Date().toISOString(),
        status: "online",
        source: "simulator",
      },
    },
    usable: true,
    plan: {
      id: "plan",
      version: "max-min-integer-v1",
      mode: "shadow",
      workload: "training",
      createdAt: new Date().toISOString(),
      budgetW: 150000,
      assignments: [0, 1, 2, 3].map((i) => ({
        id: "training-" + i,
        stationId: "training-station",
        requestedW: [100000, 80000, 60000, 50000][i],
        portLimitW: 100000,
        stationLimitW: 500000,
        plannedW: 37500,
        acknowledgedW: null,
        measuredW: null,
        currentAllocatedW: null,
      })),
    },
  };
  vi.spyOn(api, "gridPlan").mockImplementation(async () => data);
  vi.spyOn(api, "gridHistory").mockResolvedValue({
    items: [],
    nextCursor: null,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("clearly labels shadow plan, separate requested/measured/unacknowledged fields", async () => {
  render(<GridPlanningPanel />);
  await screen.findByText("150.000 кВт");
  expect(screen.getAllByText("37.500 кВт")).toHaveLength(4);
  expect(screen.getAllByText("Не применялось")).toHaveLength(4);
  expect(screen.getByText("Расчёт, не применяется к зарядкам.")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /Применить мощность/ }),
  ).toBeNull();
});
it("offline/stale data never displays a positive usable assignment", async () => {
  data.usable = false;
  data.grid.budgetW = null;
  data.grid.reading.status = "offline";
  data.grid.validity = "offline";
  render(<GridPlanningPanel />);
  await screen.findByText(
    "Достоверного текущего плана нет. Зарядки продолжают работать по прежним локальным правилам.",
  );
  expect(screen.queryByText("37.500 кВт")).toBeNull();
});
it("strict server scenario request uses stable key after network failure", async () => {
  const post = vi
    .spyOn(api, "gridScenario")
    .mockRejectedValue(new Error("Сеть недоступна"));
  render(<GridPlanningPanel />);
  await screen.findByText("150.000 кВт");
  fireEvent.change(screen.getByLabelText("Нагрузка для расчёта"), {
    target: { value: "training" },
  });
  fireEvent.change(screen.getByLabelText("Сценарий энергосистемы"), {
    target: { value: "deep_deficit" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Рассчитать сценарий" }));
  await screen.findByText("Сеть недоступна");
  fireEvent.click(screen.getByRole("button", { name: "Рассчитать сценарий" }));
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[0][1]).toBe(post.mock.calls[1][1]);
  expect(post.mock.calls[0][0]).toEqual({
    scenario: "deep_deficit",
    workload: "training",
  });
});
