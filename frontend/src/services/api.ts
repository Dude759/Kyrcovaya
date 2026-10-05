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
import { mockRequest } from "./mockApi";
import { ApiError } from "./errors";

const SESSION_KEY = "energotransport:session:v1";
export const apiMode =
  import.meta.env.VITE_API_MODE === "http" ? "http" : "mock";
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
): Promise<T> {
  if (apiMode === "mock") return mockRequest<T>(path, method, body, getToken());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const token = getToken();
    const response = await fetch(baseUrl + path, {
      method,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  profile: (input: Profile) => request<User>("/profile", "PATCH", input),
  preferences: (input: Partial<Preferences>) =>
    request<Preferences>("/preferences", "PATCH", input),
  password: (current: string, next: string) =>
    request<null>("/auth/password", "PATCH", { current, next }),
  book: (input: BookingInput) => request<Booking>("/bookings", "POST", input),
  checkout: (input: BookingInput, idempotencyKey: string) =>
    request<Payment>("/payments", "POST", { input, idempotencyKey }),
  payment: (id: string) => request<Payment>(`/payments/${id}`),
  retryPayment: (id: string) =>
    request<Payment>(`/payments/${id}/retry`, "POST"),
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
  start: (bookingId: string) =>
    request<Session>("/sessions", "POST", { bookingId }),
  stop: (id: string) => request<Session>(`/sessions/${id}/stop`, "POST"),
  station: (id: string, input: { limitKw?: number; service?: boolean }) =>
    request(`/operator/stations/${id}`, "PATCH", input),
  network: (networkLimit: number) =>
    request("/operator/network", "PATCH", { networkLimit }),
  organization: (name: string) =>
    request("/operator/organization", "PATCH", { name }),
};
