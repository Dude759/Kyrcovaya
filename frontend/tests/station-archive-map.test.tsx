import "./setup";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { StationPage } from "../src/pages/StationsPages";
import { Context, type AppState } from "../src/state/context";
import { stations } from "../src/data";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
it("station detail map excludes unrelated archived history while keeping its historical detail", () => {
  vi.stubEnv("VITE_YANDEX_MAPS_API_KEY", "");
  const archived = {
    ...stations[1],
    name: "Архивная учебная",
    archivedAt: "2026-10-29T00:00:00Z",
    status: "service" as const,
  };
  const value = {
    data: { stations: [stations[0], archived] },
    logout: async () => {},
  } as unknown as AppState;
  const show = (id: string) =>
    render(
      <MemoryRouter initialEntries={["/stations/" + id]}>
        <Context.Provider value={value}>
          <Routes>
            <Route path="/stations/:stationId" element={<StationPage />} />
          </Routes>
        </Context.Provider>
      </MemoryRouter>,
    );
  show(stations[0].id);
  expect(
    screen.queryByRole("button", { name: /Выбрать станцию Архивная учебная/ }),
  ).toBeNull();
  cleanup();
  show(archived.id);
  expect(
    screen.getByRole("heading", { level: 1, name: archived.name }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /Выбрать станцию Архивная учебная/ }),
  ).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Забронировать" })).toBeNull();
});
