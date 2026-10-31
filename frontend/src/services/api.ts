import type {
  AuthResult,
  Booking,
  BookingInput,
  Credentials,
  Preferences,
  Profile,
  Registration,
  Session,
  Snapshot,
  User,
  RecoveryResult,
  Payment,
  Forecast,
} from "../types/domain";
import type { Station } from "../data";
import { stations as mockStations } from "../data";
import { mockRequest } from "./mockApi";
import { ApiError } from "./errors";
import type {
  MonitoringSnapshot,
  MonitoringPage,
  MonitoringSession,
  PowerHistory,
  TechnicalEvent,
} from "../types/monitoring";

const SESSION_KEY = "energotransport:session:v1";
export const apiMode =
  import.meta.env.VITE_API_MODE === "http" ? "http" : "mock";
export const publicDemo = import.meta.env.VITE_PUBLIC_DEMO === "true";
const configuredTimeout = Number(import.meta.env.VITE_API_TIMEOUT_MS || 15000);
const timeoutMs =
  Number.isFinite(configuredTimeout) &&
  configuredTimeout >= 1000 &&
  configuredTimeout <= 120000
    ? configuredTimeout
    : 15000;
const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(
  /\/$/,
  "",
);
export function getToken() {
  return (
    sessionStorage.getItem(SESSION_KEY) ?? localStorage.getItem(SESSION_KEY)
  );
}
export function setToken(token: string | null, remember = true) {
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  if (token)
    (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, token);
}
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  anonymous = false,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  if (apiMode === "mock") {
    return mockRequest<T>(path, method, body, getToken());
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = anonymous ? null : getToken();
    const response = await fetch(baseUrl + path, {
      method,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 204) return null as T;
    const invalidJson = Symbol("invalidJson");
    const data = await response.json().catch(() => invalidJson);
    if (!response.ok)
      throw new ApiError(
        (data !== invalidJson ? data?.message : null) ??
          "Ошибка сервера. Повторите попытку.",
        response.status,
      );
    if (data === invalidJson)
      throw new ApiError(
        "Сервер вернул некорректные данные. Повторите попытку.",
        502,
      );
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      controller.signal.aborted
        ? "Сервер не отвечает. Повторите попытку."
        : "Не удалось соединиться с сервером. Проверьте подключение.",
      503,
    );
  } finally {
    clearTimeout(timeout);
  }
}
export const api = {
  gridPlan: () =>
    request<import("../components/GridPlanningPanel").GridPlan>(
      "/operator/power/plan",
    ),
  gridHistory: (cursor?: string) =>
    request<{ items: any[]; nextCursor: string | null }>(
      "/operator/grid/history?limit=20" +
        (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
    ),
  gridScenario: (input: { scenario: string; workload: string }, key: string) =>
    request<import("../components/GridPlanningPanel").GridPlan>(
      "/operator/grid/scenario",
      "POST",
      input,
      false,
      { "Idempotency-Key": key },
    ),
  operatorMonitoring: (stationId?: string) =>
    request<MonitoringSnapshot>(
      stationId
        ? `/operator/monitoring/stations/${encodeURIComponent(stationId)}`
        : "/operator/monitoring",
    ),
  operatorHistory: (query = "") =>
    request<MonitoringPage<PowerHistory>>(
      "/operator/monitoring/history?" + query,
    ),
  operatorSessions: (query = "") =>
    request<MonitoringPage<MonitoringSession>>("/operator/sessions?" + query),
  operatorTechnicalEvents: (query = "") =>
    request<MonitoringPage<TechnicalEvent>>(
      "/operator/monitoring/events?" + query,
    ),
  operatorStations: () =>
    request<{
      items: import("../pages/OperatorManagementPage").ManagedStation[];
    }>("/operator/stations"),
  operatorPorts: (id: string) =>
    request<{ items: import("../pages/OperatorManagementPage").ManagedPort[] }>(
      `/operator/stations/${id}/connectors`,
    ),
  operatorSave: (
    path: string,
    input: unknown,
    method: "POST" | "PATCH",
    key?: string,
  ) =>
    request<{ id: string }>(
      `/operator/${path}`,
      method,
      input,
      false,
      key ? { "Idempotency-Key": key } : {},
    ),
  operatorEvents: (cursor?: string) =>
    request<{
      items: Array<{
        id: string;
        actorId: string;
        stationId: string;
        action: string;
        date: string;
      }>;
      nextCursor: string | null;
    }>(`/operator/events?limit=10${cursor ? "&cursor=" + cursor : ""}`),
  me: () => request<User>("/auth/me"),
  login: (input: Credentials) =>
    request<AuthResult>("/auth/login", "POST", input),
  register: (input: Registration) =>
    request<AuthResult>("/auth/register", "POST", input),
  logout: () => request<null>("/auth/logout", "POST"),
  recover: (email: string) =>
    request<RecoveryResult>("/auth/recovery", "POST", { email }),
  resetPassword: (token: string, password: string) =>
    request<null>("/auth/reset", "POST", { token, password }),
  workspace: () => request<Snapshot>("/workspace"),
  stations: async () => {
    if (apiMode === "mock") return mockStations;
    const stations: Station[] = [];
    let cursor: string | null = null;
    do {
      const result: { items: Station[]; nextCursor: string | null } =
        await request(
          `/stations?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          "GET",
          undefined,
          true,
        );
      stations.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor);
    return stations;
  },
  profile: (input: Profile) => request<User>("/profile", "PATCH", input),
  preferences: (input: Partial<Preferences>) =>
    request<Preferences>("/preferences", "PATCH", input),
  password: (current: string, next: string) =>
    request<null>("/auth/password", "PATCH", { current, next }),
  book: (input: BookingInput) => request<Booking>("/bookings", "POST", input),
  checkout: (input: BookingInput, idempotencyKey: string) =>
    apiMode === "mock"
      ? request<Payment>("/payments", "POST", { input, idempotencyKey })
      : request<Payment>("/payments", "POST", { input }, false, {
          "Idempotency-Key": idempotencyKey,
        }),
  payment: (id: string) => request<Payment>(`/payments/${id}`),
  retryPayment: (id: string, key: string = crypto.randomUUID()) =>
    request<Payment>(
      `/payments/${id}/retry`,
      "POST",
      undefined,
      false,
      apiMode === "http" ? { "Idempotency-Key": key } : {},
    ),
  cancelPayment: (id: string) =>
    request<Payment>(`/payments/${id}/cancel`, "POST"),
  simulatePayment: (id: string, outcome: "succeeded" | "failed") =>
    request<Payment>(`/demo/payments/${id}`, "POST", { outcome }),
  simulateTelemetry: (id: string, connection: "online" | "offline") =>
    request<Session>(`/demo/sessions/${id}/telemetry`, "POST", { connection }),
  forecast: (scenario?: "ready" | "error" | "empty" | "stale") =>
    request<Forecast | null>("/operator/forecast", "POST", {
      ...(apiMode === "mock" ? { scenario } : {}),
    }),
  cancel: (id: string) => request<Booking>(`/bookings/${id}/cancel`, "POST"),
  start: (bookingId: string, key = crypto.randomUUID()) =>
    request<Session>(
      "/sessions",
      "POST",
      { bookingId },
      false,
      apiMode === "http" ? { "Idempotency-Key": key } : {},
    ),
  session: (id: string) => request<Session>(`/sessions/${id}`),
  stop: (id: string, key = crypto.randomUUID()) =>
    request<Session>(
      `/sessions/${id}/stop`,
      "POST",
      undefined,
      false,
      apiMode === "http" ? { "Idempotency-Key": key } : {},
    ),
  station: (id: string, input: { limitKw?: number; service?: boolean }) =>
    request(`/operator/stations/${id}`, "PATCH", input),
  network: (networkLimit: number) =>
    request("/operator/network", "PATCH", { networkLimit }),
  organization: (name: string) =>
    request("/operator/organization", "PATCH", { name }),
};
