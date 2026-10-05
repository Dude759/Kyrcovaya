import "./setup";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, setToken } from "../src/services/api";
import { demoAccounts } from "../src/services/mockApi";
import { displaySessionMetrics, telemetryState } from "../src/utils/format";
import type { Session } from "../src/types/domain";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.useRealTimers());
async function driver() {
  const auth = await api.login({
    email: demoAccounts.driver,
    password: demoAccounts.password,
    role: "driver",
  });
  setToken(auth.token);
}
const input = () => ({
  stationId: "tverskaya-plaza",
  connector: "CCS2" as const,
  duration: 45,
  payment: "sbp" as const,
  start: new Date(Date.now() + 5 * 60000).toISOString(),
});

it("ожидание и отказ оплаты не занимают разъём, повторный успех создаёт одну бронь", async () => {
  await driver();
  const before = await api.workspace();
  const attempt = await api.checkout(input(), "same-attempt");
  expect(attempt.status).toBe("pending");
  expect((await api.workspace()).bookings).toHaveLength(0);
  expect((await api.checkout(input(), "same-attempt")).id).toBe(attempt.id);
  expect((await api.simulatePayment(attempt.id, "failed")).status).toBe(
    "failed",
  );
  expect((await api.retryPayment(attempt.id)).status).toBe("pending");
  const paid = await api.simulatePayment(attempt.id, "succeeded");
  expect(paid.status).toBe("succeeded");
  expect((await api.simulatePayment(attempt.id, "succeeded")).bookingId).toBe(
    paid.bookingId,
  );
  const after = await api.workspace();
  expect(after.bookings).toHaveLength(1);
  expect(after.stations[0].connectors[0].available).toBe(
    before.stations[0].connectors[0].available - 1,
  );
  expect((await api.payment(attempt.id)).status).toBe("succeeded");
});

it("отменённый и истёкший платежи нельзя подтвердить", async () => {
  await driver();
  const attempt = await api.checkout(input(), "cancel");
  await api.cancelPayment(attempt.id);
  await expect(
    api.simulatePayment(attempt.id, "succeeded"),
  ).rejects.toMatchObject({ status: 409 });
  const expiring = await api.checkout(input(), "expire");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 6 * 60000);
  expect((await api.payment(expiring.id)).status).toBe("cancelled");
  expect((await api.workspace()).bookings).toHaveLength(0);
});

it("при занятом разъёме ожидающая оплата завершается отказом без второй брони", async () => {
  await driver();
  const attempt = await api.checkout(input(), "conflict");
  await api.book(input());
  const payment = await api.simulatePayment(attempt.id, "succeeded");
  expect(payment.status).toBe("failed");
  expect(payment.failure).toContain("уже есть бронь");
  expect((await api.workspace()).bookings).toHaveLength(1);
});

it("платёж виден только его владельцу", async () => {
  await driver();
  const attempt = await api.checkout(input(), "owner");
  const second = await api.register({
    name: "Другой водитель",
    email: "second@example.test",
    phone: "+79990000000",
    vehicle: "",
    plate: "",
    connector: "CCS2",
    battery: 75,
    password: "Second12345",
  });
  setToken(second.token);
  await expect(api.payment(attempt.id)).rejects.toMatchObject({ status: 404 });
  expect((await api.workspace()).payments).toHaveLength(0);
});

it("восстановление использует одноразовую ссылку и отзывает предыдущий вход", async () => {
  await driver();
  const recovery = await api.recover(demoAccounts.driver);
  expect(recovery.demoResetToken).toBeTruthy();
  await api.resetPassword(recovery.demoResetToken!, "Recovered12345");
  await expect(api.me()).rejects.toMatchObject({ status: 401 });
  await expect(
    api.resetPassword(recovery.demoResetToken!, "Again12345"),
  ).rejects.toMatchObject({ status: 410 });
  const login = await api.login({
    email: demoAccounts.driver,
    password: "Recovered12345",
    role: "driver",
  });
  expect(login.user.role).toBe("driver");
});

it("повторный запрос восстановления отзывает старую ссылку; новая истекает", async () => {
  const first = await api.recover(demoAccounts.operator);
  const second = await api.recover(demoAccounts.operator);
  await expect(
    api.resetPassword(first.demoResetToken!, "Updated12345"),
  ).rejects.toMatchObject({ status: 410 });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 31 * 60000);
  await expect(
    api.resetPassword(second.demoResetToken!, "Updated12345"),
  ).rejects.toMatchObject({ status: 410 });
});

it("неизвестная почта получает нейтральный ответ, короткий пароль отклоняется", async () => {
  const unknown = await api.recover("missing@example.test");
  const known = await api.recover(demoAccounts.driver);
  expect(unknown.message).toBe(known.message);
  expect(unknown.demoResetToken).toBeUndefined();
  await expect(api.resetPassword(known.demoResetToken!, "123")).rejects.toThrow(
    "8 символов",
  );
});

it("отключение телеметрии сохраняется после обновления, восстановление даёт новую отметку времени", async () => {
  await driver();
  const booking = await api.book(input());
  const session = await api.start(booking.id);
  await api.simulateTelemetry(session.id, "offline");
  const offline = (await api.workspace()).sessions[0];
  expect(telemetryState(offline)).toBe("offline");
  expect(displaySessionMetrics(offline, 100, Date.now() + 60000).energy).toBe(
    offline.telemetry?.energy,
  );
  await api.simulateTelemetry(session.id, "online");
  expect(telemetryState((await api.workspace()).sessions[0])).toBe("online");
});

it("показания настоящего устройства и устаревшие данные не экстраполируются", () => {
  const now = Date.now();
  const session: Session = {
    id: "s",
    userId: "u",
    bookingId: "b",
    stationId: "s",
    connector: "CCS2",
    startedAt: new Date(now - 3600000).toISOString(),
    meteredAt: new Date(now - 3600000).toISOString(),
    batteryCapacity: 100,
    endedAt: null,
    energy: 10,
    power: 100,
    initialCharge: 20,
    targetCharge: 80,
    tariff: 18,
    status: "active",
    telemetry: {
      source: "device",
      connection: "online",
      energy: 10,
      receivedAt: new Date(now - 30000).toISOString(),
    },
  };
  expect(displaySessionMetrics(session, 100, now).energy).toBe(10);
  session.telemetry!.energy = 90;
  expect(displaySessionMetrics(session, 100, now).energy).toBe(90);
  session.telemetry!.energy = 10;
  session.telemetry!.source = "demo";
  session.telemetry!.receivedAt = new Date(now - 61000).toISOString();
  expect(telemetryState(session, now)).toBe("stale");
  expect(displaySessionMetrics(session, 100, now).energy).toBe(10);
});

it("прогноз ограничен ролью оператора, поддерживает ошибку, пустое и устаревшее состояние", async () => {
  await driver();
  await expect(api.forecast()).rejects.toMatchObject({ status: 403 });
  const operator = await api.login({
    email: demoAccounts.operator,
    password: demoAccounts.password,
    role: "operator",
  });
  setToken(operator.token);
  await expect(api.forecast("error")).rejects.toMatchObject({ status: 503 });
  expect(await api.forecast("empty")).toBeNull();
  const stale = await api.forecast("stale");
  expect(Date.now() - Date.parse(stale!.generatedAt)).toBeGreaterThan(3600000);
  expect((await api.forecast())?.points).toHaveLength(25);
});
