import "./setup";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AppProvider, ProtectedRoute } from "../src/state/AppProvider";
import { api, setToken } from "../src/services/api";
import { demoAccounts } from "../src/services/mockApi";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);
function GuardFixture() {
  return (
    <MemoryRouter initialEntries={["/operator"]}>
      <AppProvider>
        <Routes>
          <Route path="/login" element={<h1>Вход</h1>} />
          <Route path="/driver/stations" element={<h1>Карта водителя</h1>} />
          <Route element={<ProtectedRoute role="operator" />}>
            <Route
              path="/operator"
              element={<h1>Рабочая область оператора</h1>}
            />
          </Route>
        </Routes>
      </AppProvider>
    </MemoryRouter>
  );
}
it("гостя отправляет на вход", async () => {
  render(<GuardFixture />);
  expect(await screen.findByRole("heading", { name: "Вход" })).toBeTruthy();
});
it("водителю не открывает операторский раздел", async () => {
  const auth = await api.login({
    email: demoAccounts.driver,
    password: demoAccounts.password,
    role: "driver",
  });
  setToken(auth.token);
  render(<GuardFixture />);
  expect(
    await screen.findByRole("heading", { name: "Карта водителя" }),
  ).toBeTruthy();
});
it("оператору восстанавливает рабочую область после повторного открытия", async () => {
  const auth = await api.login({
    email: demoAccounts.operator,
    password: demoAccounts.password,
    role: "operator",
  });
  setToken(auth.token);
  render(<GuardFixture />);
  expect(
    await screen.findByRole("heading", { name: "Рабочая область оператора" }),
  ).toBeTruthy();
});
