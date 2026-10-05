import "./setup";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import App from "../src/App";
import { api } from "../src/services/api";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv("VITE_YANDEX_MAPS_API_KEY", "");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const button = (name: string) =>
  screen.getByRole("button", { name, exact: true });
const click = (name: string) => fireEvent.click(button(name));
async function readyButton(name: string) {
  await waitFor(() =>
    expect((button(name) as HTMLButtonElement).disabled).toBe(false),
  );
}

it("полный путь водителя: отказ, возврат к оплате, повтор, зарядка, потеря связи и завершение", async () => {
  window.history.replaceState({}, "", "/login");
  render(<App />);
  click("Войти");
  await screen.findByRole("heading", { name: "Зарядные станции" });
  fireEvent.click(screen.getAllByRole("link", { name: "Подробнее →" })[0]);
  fireEvent.click(
    await screen.findByRole("link", { name: "Забронировать", exact: true }),
  );
  click("Перейти к оплате");
  click("Открыть тестовую оплату");
  await screen.findByRole("heading", { name: "Подтверждение оплаты" });
  await readyButton("Проверить отказ");
  click("Проверить отказ");
  await screen.findByRole("heading", { name: "Оплата не прошла" });
  await readyButton("Повторить оплату");
  fireEvent.click(screen.getByRole("link", { name: "Брони", exact: true }));
  expect(await screen.findByText("Оплата отклонена")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("link", { name: "Вернуться к оплате", exact: true }),
  );
  await screen.findByRole("heading", { name: "Оплата не прошла" });
  click("Повторить оплату");
  await readyButton("Подтвердить тестовую оплату");
  click("Подтвердить тестовую оплату");
  await screen.findByText("Бронь подтверждена");
  click("Начать зарядку");
  await screen.findByRole("heading", { name: "Зарядка идёт" });
  fireEvent.click(
    screen.getByText("Проверить потерю связи · демо", { exact: true }),
  );
  click("Имитировать потерю связи");
  await screen.findByText("Нет связи со станцией");
  expect(
    screen.getByRole("heading", { name: "Ожидаем новые показания" }),
  ).toBeTruthy();
  await readyButton("Восстановить связь");
  click("Восстановить связь");
  await screen.findByRole("heading", { name: "Зарядка идёт" });
  click("Остановить зарядку");
  click("Подтвердить завершение");
  await screen.findByRole("heading", { name: "Зарядка завершена" });
  expect(button("Скачать отчёт о сессии")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("link", { name: "Все сессии →", exact: true }),
  );
  expect(await screen.findByText("Завершена", { exact: true })).toBeTruthy();
}, 15000);

it("оператор входит без регистрации и восстанавливает прогноз после ошибки", async () => {
  window.history.replaceState({}, "", "/login?role=operator");
  render(<App />);
  expect(screen.queryByRole("link", { name: "Зарегистрироваться" })).toBeNull();
  click("Войти");
  await screen.findByRole("heading", { name: "Панель оператора" });
  fireEvent.click(
    screen.getByText("Проверить состояния прогноза · демо", { exact: true }),
  );
  click("Ошибка расчёта");
  await screen.findByText("Не удалось обновить прогноз. Попробуйте ещё раз.");
  click("Повторить расчёт");
  await readyButton("Обновить прогноз");
  expect(
    screen.queryByText("Не удалось обновить прогноз. Попробуйте ещё раз."),
  ).toBeNull();
  click("Устаревший прогноз");
  await screen.findByText(/Прогноз устарел/);
  await readyButton("Нет данных");
  click("Нет данных");
  await screen.findByText(/Прогноз пока недоступен/);
  await readyButton("Обновить прогноз");
  click("Обновить прогноз");
  await screen.findByRole("img", { name: /Прогноз нагрузки на сутки/ });
}, 10000);

it("публичная форма восстановления показывает тестовую ссылку и ошибку недействительного кода", async () => {
  window.history.replaceState({}, "", "/forgot-password");
  render(<App />);
  fireEvent.change(screen.getByLabelText("Электронная почта"), {
    target: { value: "driver@energotransport.test" },
  });
  click("Получить ссылку");
  expect(
    await screen.findByRole("link", {
      name: "Открыть тестовую ссылку →",
      exact: true,
    }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("link", {
      name: "Открыть тестовую ссылку →",
      exact: true,
    }),
  );
  fireEvent.change(screen.getByLabelText("Новый пароль"), {
    target: { value: "New123456" },
  });
  fireEvent.change(screen.getByLabelText("Повторите пароль"), {
    target: { value: "Different123" },
  });
  click("Сохранить пароль");
  expect(screen.getByText("Пароли не совпадают.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Повторите пароль"), {
    target: { value: "New123456" },
  });
  click("Сохранить пароль");
  expect(
    await screen.findByRole("heading", { name: "Пароль обновлён" }),
  ).toBeTruthy();
});

it("ошибка фонового обновления сохраняет экран и последние данные, повтор убирает предупреждение", async () => {
  window.history.replaceState({}, "", "/login");
  render(<App />);
  click("Войти");
  await screen.findByRole("heading", { name: "Зарядные станции" });
  const update = vi
    .spyOn(api, "workspace")
    .mockRejectedValueOnce(new Error("Нет соединения"));
  fireEvent.focus(window);
  await screen.findByText(/Не удалось обновить данные/);
  expect(
    screen.getByRole("heading", { name: "Зарядные станции" }),
  ).toBeTruthy();
  click("Повторить обновление");
  await waitFor(() =>
    expect(screen.queryByText(/Не удалось обновить данные/)).toBeNull(),
  );
  expect(update).toHaveBeenCalledTimes(2);
});
