import "./setup";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_API_MODE", "http");
  vi.stubEnv("VITE_API_BASE_URL", "/api/");
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("отправляет авторизацию и JSON на выбранный сервер", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ networkLimit: 5000 }), { status: 200 }),
    );
  vi.stubGlobal("fetch", fetchMock);
  const { api, setToken } = await import("../src/services/api");
  setToken("test-token");
  await api.network(5000);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/operator/network",
    expect.objectContaining({
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: '{"networkLimit":5000}',
    }),
  );
});
it("поддерживает ответ без тела после выхода", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
  );
  const { api } = await import("../src/services/api");
  expect(await api.logout()).toBeNull();
});
it("поддерживает пустой прогноз как корректный JSON null и не отправляет демо-сценарий серверу", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response("null", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const { api } = await import("../src/services/api");
  expect(await api.forecast("error")).toBeNull();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/operator/forecast",
    expect.objectContaining({ method: "POST", body: "{}" }),
  );
});
it("успешный HTTP-ответ с HTML вместо данных отклоняется", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(new Response("<html>error</html>", { status: 200 })),
  );
  const { api } = await import("../src/services/api");
  await expect(api.workspace()).rejects.toMatchObject({ status: 502 });
});
it("сохраняет серверную ошибку валидации", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Разъём уже занят" }), {
        status: 409,
      }),
    ),
  );
  const { api } = await import("../src/services/api");
  await expect(api.start("booking-id")).rejects.toMatchObject({
    status: 409,
    message: "Разъём уже занят",
  });
});
it("распознаёт ошибку сервера даже при HTML вместо JSON", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(new Response("<h1>Bad Gateway</h1>", { status: 502 })),
  );
  const { api } = await import("../src/services/api");
  await expect(api.workspace()).rejects.toMatchObject({
    status: 502,
    message: "Ошибка сервера. Повторите попытку.",
  });
});
it("прерывает запрос, когда сервер не отвечает", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            ),
          ),
      ),
  );
  const { api } = await import("../src/services/api");
  const assertion = expect(api.workspace()).rejects.toMatchObject({
    status: 503,
    message: "Сервер не отвечает. Повторите попытку.",
  });
  await vi.advanceTimersByTimeAsync(15000);
  await assertion;
});
