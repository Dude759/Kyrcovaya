import "./setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, getToken, setToken } from "../src/services/api";
import { demoAccounts } from "../src/services/mockApi";
import { sessionMetrics } from "../src/utils/format";
import type { Role } from "../src/types/domain";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.useRealTimers());
async function login(role: Role = "driver") {
  const result = await api.login({
    email: demoAccounts[role],
    password: demoAccounts.password,
    role,
  });
  setToken(result.token);
  return result;
}
const booking = () => ({
  stationId: "tverskaya-plaza",
  connector: "CCS2" as const,
  duration: 45,
  payment: "card" as const,
  start: new Date(Date.now() + 5 * 60000).toISOString(),
});
describe("Вход и доступ", () => {
  it("проверяет пароль и роль", async () => {
    await expect(
      api.login({
        email: demoAccounts.driver,
        password: "bad",
        role: "driver",
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      api.login({
        email: demoAccounts.driver,
        password: demoAccounts.password,
        role: "operator",
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("восстанавливает вход и отзывает токен при выходе", async () => {
    const result = await login();
    expect((await api.me()).id).toBe(result.user.id);
    await api.logout();
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
  });
  it("запрещает изменение операторского лимита водителю", async () => {
    await login();
    await expect(
      api.station("tverskaya-plaza", { limitKw: 500 }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("хранит вход без запоминания только до конца сессии браузера", async () => {
    const result = await api.login({
      email: demoAccounts.driver,
      password: demoAccounts.password,
      role: "driver",
    });
    setToken(result.token, false);
    expect(getToken()).toBe(result.token);
    expect(localStorage.getItem("energotransport:session:v1")).toBeNull();
  });
  it("создаёт только водителя, сохраняет профиль и уведомления", async () => {
    const result = await api.register({
      name: "Тестовый водитель",
      email: "new@example.test",
      phone: "+7 999 1112233",
      password: "Test12345",
      vehicle: "Model 3",
      plate: "",
      connector: "CCS2",
      battery: 75,
    });
    setToken(result.token);
    expect(result.user.role).toBe("driver");
    await api.profile({ ...result.user, vehicle: "Model Y", battery: 80 });
    await api.preferences({ networkAlerts: true });
    expect((await api.me()).vehicle).toBe("Model Y");
    expect((await api.workspace()).preferences.networkAlerts).toBe(true);
  });
  it("смена пароля проверяет старый и требует новый при следующем входе", async () => {
    await login();
    await expect(api.password("bad", "Next12345")).rejects.toThrow(
      "Текущий пароль",
    );
    await api.password(demoAccounts.password, "Next12345");
    await api.logout();
    await expect(
      api.login({
        email: demoAccounts.driver,
        password: demoAccounts.password,
        role: "driver",
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (
        await api.login({
          email: demoAccounts.driver,
          password: "Next12345",
          role: "driver",
        })
      ).user.role,
    ).toBe("driver");
  });
});
describe("Бронирование и зарядка", () => {
  it("сохраняет выбранную станцию, снижает доступность и восстанавливает её после отмены", async () => {
    await login();
    const created = await api.book({ ...booking(), stationId: "khodynka" });
    expect(created.amount).toBe(480);
    expect(
      (await api.workspace()).stations.find((s) => s.id === "khodynka")!
        .connectors[0].available,
    ).toBe(2);
    await api.cancel(created.id);
    expect(
      (await api.workspace()).stations.find((s) => s.id === "khodynka")!
        .connectors[0].available,
    ).toBe(3);
    await expect(api.cancel(created.id)).rejects.toMatchObject({ status: 409 });
  });
  it("не позволяет бронировать прошлое, сервисную станцию и пересекающееся время", async () => {
    await login();
    await expect(
      api.book({
        ...booking(),
        start: new Date(Date.now() - 60000).toISOString(),
      }),
    ).rejects.toThrow("Проверьте дату");
    await expect(
      api.book({ ...booking(), stationId: "river-station" }),
    ).rejects.toMatchObject({ status: 409 });
    const input = booking();
    await api.book(input);
    await expect(api.book(input)).rejects.toMatchObject({ status: 409 });
  });
  it("проводит полный цикл зарядки и сохраняет энергию и итоговую стоимость", async () => {
    await login();
    const created = await api.book(booking());
    const started = await api.start(created.id);
    expect(started.stationId).toBe(created.stationId);
    expect(started.status).toBe("active");
    const value = sessionMetrics(
      started,
      100,
      Date.parse(started.startedAt) + 3600000,
    );
    expect(value.energy).toBeGreaterThan(0);
    expect(value.amount).toBe(Math.round(value.energy * started.tariff));
    await api.stop(started.id);
    const snapshot = await api.workspace();
    expect(snapshot.sessions[0].status).toBe("completed");
    expect(snapshot.sessions[0].endedAt).not.toBeNull();
    expect(snapshot.stations[0].connectors[0].available).toBe(2);
    await expect(api.start(created.id)).rejects.toMatchObject({ status: 404 });
  });
  it("не разрешает использовать чужую бронь и не раскрывает историю другого водителя", async () => {
    await login();
    const created = await api.book(booking());
    const result = await api.register({
      name: "Другой водитель",
      email: "other@example.test",
      phone: "+7 999 2223344",
      password: "Other12345",
      vehicle: "",
      plate: "",
      connector: "CCS2",
      battery: 100,
    });
    setToken(result.token);
    expect((await api.workspace()).bookings).toHaveLength(0);
    await expect(api.start(created.id)).rejects.toMatchObject({ status: 404 });
  });
});
describe("Оператор и ошибки", () => {
  it("при изменении мощности сохраняет накопленную энергию и время начала", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await login();
    const created = await api.book(booking());
    const started = await api.start(created.id);
    vi.setSystemTime(Date.parse(started.startedAt) + 5 * 60000);
    await login("operator");
    await api.station(created.stationId, { limitKw: 120 });
    const changed = (await api.workspace()).sessions[0];
    expect(changed.startedAt).toBe(started.startedAt);
    expect(changed.energy).toBe(8.8);
    expect(changed.power).toBe(30);
    expect(
      sessionMetrics(changed, 100, Date.parse(changed.meteredAt) + 5 * 60000)
        .energy,
    ).toBe(11.3);
  });
  it("сохраняет лимиты, сервисный режим и журнал событий", async () => {
    await login("operator");
    await api.station("tverskaya-plaza", { limitKw: 500 });
    await api.station("tverskaya-plaza", { service: true });
    await api.network(5000);
    await api.organization("Новая организация");
    const snapshot = await api.workspace();
    expect(snapshot.stations[0].limitKw).toBe(500);
    expect(snapshot.stations[0].status).toBe("service");
    expect(snapshot.networkLimit).toBe(5000);
    expect(snapshot.organization).toBe("Новая организация");
    expect(snapshot.events[0].message).toContain("5000");
  });
  it("проверяет диапазоны лимита сети и станции", async () => {
    await login("operator");
    await expect(
      api.station("tverskaya-plaza", { limitKw: 700 }),
    ).rejects.toThrow("Допустимый лимит");
    await expect(api.network(2000)).rejects.toThrow("Лимит должен покрывать");
  });
  it("не разрешает сервисный режим при активной зарядке", async () => {
    await login();
    const created = await api.book(booking());
    await api.start(created.id);
    await login("operator");
    await expect(
      api.station("tverskaya-plaza", { service: true }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("явно сообщает о повреждённых данных вместо молчаливого сброса", async () => {
    localStorage.setItem("energotransport:database:v1", "invalid");
    await expect(api.me()).rejects.toThrow("повреждены");
  });
});
