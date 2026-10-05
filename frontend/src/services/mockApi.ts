import { stations } from "../data";
import type {
  AuthResult,
  Booking,
  BookingInput,
  Credentials,
  NetworkEvent,
  Preferences,
  Profile,
  Registration,
  Role,
  Session,
  Snapshot,
  User,
  Payment,
  Forecast,
} from "../types/domain";
import { sessionMetrics } from "../utils/format";
import { ApiError } from "./errors";

const DB_KEY = "energotransport:database:v1";
const defaults: Preferences = {
  bookingAlerts: true,
  receipts: true,
  networkAlerts: false,
  criticalAlerts: true,
  loadAlerts: true,
  reports: false,
};
type Account = {
  user: User;
  passwordHash: string;
  salt: string;
  preferences: Preferences;
};
type Database = {
  version: 1;
  accounts: Account[];
  tokens: { token: string; userId: string; expires: number }[];
  stations: Snapshot["stations"];
  bookings: Booking[];
  sessions: Session[];
  networkLimit: number;
  organization: string;
  events: NetworkEvent[];
  payments?: (Payment & { idempotencyKey: string })[];
  recoveries?: { token: string; userId: string; expires: number }[];
};
let initializing: Promise<Database> | null = null;
export const demoAccounts = {
  driver: "driver@energotransport.test",
  operator: "operator@energotransport.test",
  password: "Demo12345",
};
const id = () => crypto.randomUUID();
const stamp = () => new Date().toISOString();

async function hash(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bytes = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
    },
    key,
    256,
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function save(db: Database) {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch {
    throw new ApiError(
      "Браузер не разрешает сохранить данные. Освободите место или разрешите локальное хранилище.",
      507,
    );
  }
}

async function database(): Promise<Database> {
  const raw = localStorage.getItem(DB_KEY);
  if (raw) {
    try {
      const db: Database = JSON.parse(raw);
      if (
        db.version !== 1 ||
        !Array.isArray(db.accounts) ||
        !Array.isArray(db.stations) ||
        !Array.isArray(db.tokens) ||
        !Array.isArray(db.bookings) ||
        !Array.isArray(db.sessions) ||
        !Array.isArray(db.events)
      )
        throw new Error();
      return db;
    } catch {
      throw new ApiError(
        "Локальные данные повреждены. Откройте приложение в новом профиле браузера или очистите данные этого сайта.",
        500,
      );
    }
  }
  if (!initializing)
    initializing = (async () => {
      const accounts: Account[] = [];
      for (const role of ["driver", "operator"] as const) {
        const salt = id();
        accounts.push({
          user: {
            id: role,
            role,
            name: role === "driver" ? "Иван Петров" : "Анна Соколова",
            email: demoAccounts[role],
            phone: "+7 999 000-00-00",
            vehicle: "Zeekr 001",
            plate: "А123ВС 77",
            connector: "CCS2",
            battery: 100,
          },
          salt,
          passwordHash: await hash(demoAccounts.password, salt),
          preferences: { ...defaults },
        });
      }
      const db: Database = {
        version: 1,
        accounts,
        tokens: [],
        stations: structuredClone(stations),
        bookings: [],
        sessions: [],
        networkLimit: 6000,
        organization: "ООО «Энергосеть Москва»",
        events: [
          {
            id: id(),
            stationId: "city-hub",
            date: stamp(),
            message: "Высокая нагрузка: 91% выделенной мощности",
            severity: "warning",
          },
          {
            id: id(),
            stationId: "leningradskaya",
            date: stamp(),
            message: "Нет связи со станцией. Требуется диагностика.",
            severity: "danger",
          },
        ],
      };
      save(db);
      return db;
    })().finally(() => {
      initializing = null;
    });
  return structuredClone(await initializing);
}

function authorize(db: Database, token: string | null, role?: Role) {
  const session = db.tokens.find(
    (item) => item.token === token && item.expires > Date.now(),
  );
  const account = db.accounts.find((item) => item.user.id === session?.userId);
  if (!account) throw new ApiError("Сессия завершена. Войдите снова.", 401);
  if (role && account.user.role !== role)
    throw new ApiError("Нет доступа к этому разделу.", 403);
  return account;
}
function event(db: Database, message: string, stationId: string | null = null) {
  db.events.unshift({
    id: id(),
    stationId,
    message,
    date: stamp(),
    severity: "info",
  });
}
function issueToken(db: Database, user: User): AuthResult {
  const token = id();
  db.tokens.push({
    token,
    userId: user.id,
    expires: Date.now() + 7 * 86400000,
  });
  return { token, user };
}
function stationById(db: Database, stationId: string) {
  const station = db.stations.find((item) => item.id === stationId);
  if (!station) throw new ApiError("Станция не найдена.", 404);
  return station;
}
function validateProfile(profile: Profile) {
  if (
    profile.name.trim().length < 2 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email) ||
    profile.phone.replace(/\D/g, "").length < 10 ||
    !Number.isFinite(profile.battery) ||
    profile.battery < 10 ||
    profile.battery > 250
  )
    throw new ApiError(
      "Проверьте имя, почту, телефон и ёмкость батареи (10–250 кВт⋅ч).",
    );
}
function returnPort(db: Database, booking: Booking) {
  const connector = stationById(db, booking.stationId).connectors.find(
    (item) => item.type === booking.connector,
  )!;
  connector.available = Math.min(connector.total, connector.available + 1);
}

function validateBooking(db: Database, user: User, input: BookingInput) {
  const station = stationById(db, input.stationId);
  const connector = station.connectors.find((c) => c.type === input.connector);
  if (
    ["offline", "service"].includes(station.status) ||
    !connector ||
    connector.available < 1
  )
    throw new ApiError(
      "Выбранный разъём недоступен. Выберите другую станцию.",
      409,
    );
  const start = Date.parse(input.start);
  if (
    !Number.isFinite(start) ||
    start < Date.now() ||
    start > Date.now() + 4 * 86400000 ||
    ![30, 45, 60, 90].includes(input.duration) ||
    !["card", "sbp"].includes(input.payment)
  )
    throw new ApiError(
      "Проверьте дату, время и продолжительность бронирования.",
    );
  if (
    db.bookings.some(
      (b) =>
        b.userId === user.id &&
        b.status === "confirmed" &&
        start < Date.parse(b.start) + b.duration * 60000 &&
        Date.parse(b.start) < start + input.duration * 60000,
    )
  )
    throw new ApiError("У вас уже есть бронь на это время.", 409);
  const amount = Math.round(
    Math.min(
      ((connector.powerKw * input.duration) / 60) * 0.65,
      user.battery * 0.3,
    ) * station.pricePerKwh,
  );
  return { connector, amount };
}
function createBooking(db: Database, user: User, input: BookingInput): Booking {
  const { connector, amount } = validateBooking(db, user, input);
  const booking: Booking = {
    ...input,
    id: id(),
    userId: user.id,
    amount,
    status: "confirmed",
    createdAt: stamp(),
  };
  db.bookings.unshift(booking);
  connector.available--;
  return booking;
}
function forecast(db: Database): Forecast {
  const allocated = db.stations
    .filter((s) => !["offline", "service"].includes(s.status))
    .reduce((sum, s) => sum + s.limitKw, 0);
  const factors = [
    0.2, 0.18, 0.17, 0.17, 0.2, 0.27, 0.4, 0.6, 0.74, 0.7, 0.6, 0.55, 0.6, 0.58,
    0.56, 0.62, 0.72, 0.84, 0.92, 0.86, 0.72, 0.56, 0.4, 0.3,
  ];
  return {
    source: "demo",
    generatedAt: stamp(),
    points: Array.from({ length: 25 }, (_, index) => {
      const time = new Date(Date.now() + index * 3600000);
      const hour = Number(
        new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          hourCycle: "h23",
          timeZone: "Europe/Moscow",
        }).format(time),
      );
      return {
        time: time.toISOString(),
        powerKw: Math.round(allocated * factors[hour]),
      };
    }),
  };
}

function visibleSession(session: Session, battery: number): Session {
  const copy = structuredClone(session);
  if (copy.status === "active" && copy.telemetry?.connection !== "offline")
    copy.telemetry = {
      source: "demo",
      connection: "online",
      receivedAt: stamp(),
      energy: sessionMetrics(session, battery).energy,
    };
  return copy;
}

// The same endpoint contract is used by the HTTP adapter. Mock mutations are synchronous after validation.
export async function mockRequest<T>(
  path: string,
  method: string,
  body: unknown,
  token: string | null,
): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 120));
  let db = await database();
  let result: unknown;
  if (path === "/auth/login") {
    const input = body as Credentials;
    const account = db.accounts.find(
      (item) =>
        item.user.email.toLowerCase() === input.email.trim().toLowerCase() &&
        item.user.role === input.role,
    );
    if (
      !account ||
      (await hash(input.password, account.salt)) !== account.passwordHash
    )
      throw new ApiError("Неверная почта, пароль или роль.", 401);
    db = await database();
    result = issueToken(
      db,
      db.accounts.find((item) => item.user.id === account.user.id)!.user,
    );
  } else if (path === "/auth/register") {
    const input = body as Registration;
    validateProfile(input);
    if (input.password.length < 8)
      throw new ApiError("Пароль должен содержать не менее 8 символов.");
    const salt = id();
    const passwordHash = await hash(input.password, salt);
    db = await database();
    if (
      db.accounts.some(
        (item) => item.user.email.toLowerCase() === input.email.toLowerCase(),
      )
    )
      throw new ApiError("Аккаунт с такой почтой уже существует.", 409);
    const profile: Profile = {
      name: input.name,
      email: input.email,
      phone: input.phone,
      vehicle: input.vehicle,
      plate: input.plate,
      connector: input.connector,
      battery: input.battery,
    };
    const user: User = {
      ...profile,
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      id: id(),
      role: "driver",
    };
    db.accounts.push({
      user,
      salt,
      passwordHash,
      preferences: { ...defaults },
    });
    result = issueToken(db, user);
  } else if (path === "/auth/recovery" && method === "POST") {
    const email = String((body as { email: string }).email)
      .trim()
      .toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new ApiError("Укажите корректную почту.");
    const account = db.accounts.find(
      (a) => a.user.email.toLowerCase() === email,
    );
    const resetToken = account ? id() : undefined;
    db.recoveries = (db.recoveries ?? []).filter(
      (r) => r.expires > Date.now() && r.userId !== account?.user.id,
    );
    if (account && resetToken)
      db.recoveries.push({
        token: resetToken,
        userId: account.user.id,
        expires: Date.now() + 30 * 60000,
      });
    result = {
      message:
        "Если аккаунт существует, вы получите ссылку для восстановления доступа.",
      ...(resetToken ? { demoResetToken: resetToken } : {}),
    };
  } else if (path === "/auth/reset" && method === "POST") {
    const input = body as { token: string; password: string };
    const recovery = db.recoveries?.find(
      (r) => r.token === input.token && r.expires > Date.now(),
    );
    if (!recovery)
      throw new ApiError(
        "Ссылка истекла или уже использована. Запросите новую.",
        410,
      );
    if (input.password.length < 8)
      throw new ApiError("Пароль должен содержать не менее 8 символов.");
    const account = db.accounts.find((a) => a.user.id === recovery.userId)!;
    const salt = id();
    const passwordHash = await hash(input.password, salt);
    db = await database();
    if (
      !db.recoveries?.some(
        (r) => r.token === input.token && r.expires > Date.now(),
      )
    )
      throw new ApiError(
        "Ссылка истекла или уже использована. Запросите новую.",
        410,
      );
    Object.assign(
      db.accounts.find((a) => a.user.id === account.user.id)!,
      { salt, passwordHash },
    );
    db.recoveries = db.recoveries.filter((r) => r.userId !== account.user.id);
    db.tokens = db.tokens.filter((t) => t.userId !== account.user.id);
    result = null;
  } else if (path === "/stations" && method === "GET")
    return structuredClone(db.stations) as T;
  else {
    const account = authorize(db, token);
    if (path === "/auth/me") return structuredClone(account.user) as T;
    if (path === "/auth/logout") {
      db.tokens = db.tokens.filter((item) => item.token !== token);
      result = null;
    } else if (path === "/workspace")
      return structuredClone({
        stations: db.stations,
        bookings: db.bookings.filter(
          (b) =>
            account.user.role === "operator" || b.userId === account.user.id,
        ),
        sessions: db.sessions
          .filter(
            (s) =>
              account.user.role === "operator" || s.userId === account.user.id,
          )
          .map((s) =>
            visibleSession(
              s,
              db.accounts.find((a) => a.user.id === s.userId)?.user.battery ??
                s.batteryCapacity,
            ),
          ),
        preferences: account.preferences,
        networkLimit: db.networkLimit,
        organization: db.organization,
        events: account.user.role === "operator" ? db.events : [],
        forecast: account.user.role === "operator" ? forecast(db) : null,
        payments: (db.payments ?? [])
          .filter((p) => p.userId === account.user.id)
          .map((p) =>
            p.status === "pending" && Date.parse(p.expiresAt) <= Date.now()
              ? { ...p, status: "cancelled", failure: "Время оплаты истекло." }
              : p,
          ),
      }) as T;
    else if (path === "/operator/forecast") {
      authorize(db, token, "operator");
      const scenario = (body as { scenario?: string })?.scenario;
      if (scenario === "error")
        throw new ApiError(
          "Не удалось обновить прогноз. Попробуйте ещё раз.",
          503,
        );
      if (scenario === "empty") return null as T;
      const value = forecast(db);
      if (scenario === "stale")
        value.generatedAt = new Date(Date.now() - 2 * 3600000).toISOString();
      return value as T;
    } else if (path === "/payments" && method === "POST") {
      authorize(db, token, "driver");
      const { input, idempotencyKey } = body as {
        input: BookingInput;
        idempotencyKey: string;
      };
      if (!idempotencyKey)
        throw new ApiError("Не указан идентификатор попытки.");
      db.payments ??= [];
      const existing = db.payments.find(
        (p) =>
          p.userId === account.user.id && p.idempotencyKey === idempotencyKey,
      );
      if (existing) return structuredClone(existing) as T;
      const { amount } = validateBooking(db, account.user, input);
      const payment: Payment & { idempotencyKey: string } = {
        id: id(),
        userId: account.user.id,
        input,
        idempotencyKey,
        amount,
        status: "pending",
        bookingId: null,
        createdAt: stamp(),
        expiresAt: new Date(
          Math.min(Date.now() + 15 * 60000, Date.parse(input.start)),
        ).toISOString(),
        failure: null,
      };
      db.payments.unshift(payment);
      result = payment;
    } else if (
      /^\/(?:demo\/)?payments\/[^/]+(?:\/(?:retry|cancel))?$/.test(path)
    ) {
      authorize(db, token, "driver");
      const paymentId = path.split("/")[path.startsWith("/demo/") ? 3 : 2];
      const payment = db.payments?.find(
        (p) => p.id === paymentId && p.userId === account.user.id,
      );
      if (!payment) throw new ApiError("Платёж не найден.", 404);
      if (
        ["pending", "failed"].includes(payment.status) &&
        Date.parse(payment.expiresAt) <= Date.now()
      ) {
        payment.status = "cancelled";
        payment.failure = "Время оплаты истекло. Создайте новую бронь.";
      }
      if (path.startsWith("/demo/") && method === "POST") {
        if (payment.status !== "pending") {
          if (payment.status === "succeeded")
            return structuredClone(payment) as T;
          throw new ApiError(
            "Этот платёж больше не ожидает подтверждения.",
            409,
          );
        }
        const outcome = (body as { outcome: string }).outcome;
        if (outcome === "failed") {
          payment.status = "failed";
          payment.failure =
            "Платёж отклонён. Деньги не списаны. Повторите попытку или выберите другой способ оплаты.";
        } else if (outcome === "succeeded") {
          try {
            const booking = createBooking(db, account.user, payment.input);
            payment.status = "succeeded";
            payment.bookingId = booking.id;
          } catch (err) {
            payment.status = "failed";
            payment.failure =
              err instanceof Error ? err.message : "Бронь недоступна.";
          }
        } else throw new ApiError("Неизвестный исход платежа.");
      } else if (path.endsWith("/retry") && method === "POST") {
        if (payment.status !== "failed")
          throw new ApiError("Повторная оплата сейчас недоступна.", 409);
        if (Date.parse(payment.expiresAt) <= Date.now())
          throw new ApiError(
            "Время оплаты истекло. Создайте новую бронь.",
            410,
          );
        validateBooking(db, account.user, payment.input);
        payment.status = "pending";
        payment.failure = null;
      } else if (path.endsWith("/cancel") && method === "POST") {
        if (payment.status === "succeeded")
          throw new ApiError(
            "Оплата уже подтверждена. Отмените бронь в личном кабинете.",
            409,
          );
        payment.status = "cancelled";
      }
      result = payment;
    } else if (/^\/demo\/sessions\/[^/]+\/telemetry$/.test(path)) {
      const session = db.sessions.find(
        (s) => s.id === path.split("/")[3] && s.userId === account.user.id,
      );
      if (!session || session.status !== "active")
        throw new ApiError("Активная сессия не найдена.", 404);
      const connection = (body as { connection: string }).connection;
      if (!["online", "offline"].includes(connection))
        throw new ApiError("Неизвестное состояние связи.");
      session.telemetry = {
        source: "demo",
        connection: connection as "online" | "offline",
        receivedAt: stamp(),
        energy: sessionMetrics(session, account.user.battery).energy,
      };
      result = session;
    } else if (path === "/profile") {
      const input = body as Profile;
      validateProfile(input);
      if (
        db.accounts.some(
          (a) =>
            a.user.id !== account.user.id &&
            a.user.email.toLowerCase() === input.email.toLowerCase(),
        )
      )
        throw new ApiError("Эта почта уже используется.", 409);
      account.user = {
        ...account.user,
        phone: input.phone,
        vehicle: input.vehicle,
        plate: input.plate,
        connector: input.connector,
        battery: input.battery,
        name: input.name.trim(),
        email: input.email.trim().toLowerCase(),
      };
      result = account.user;
    } else if (path === "/preferences") {
      account.preferences = {
        ...account.preferences,
        ...(body as Partial<Preferences>),
      };
      result = account.preferences;
    } else if (path === "/auth/password") {
      const input = body as { current: string; next: string };
      if ((await hash(input.current, account.salt)) !== account.passwordHash)
        throw new ApiError("Текущий пароль указан неверно.");
      if (input.next.length < 8)
        throw new ApiError(
          "Новый пароль должен содержать не менее 8 символов.",
        );
      const nextHash = await hash(input.next, account.salt);
      db = await database();
      db.accounts.find((a) => a.user.id === account.user.id)!.passwordHash =
        nextHash;
      db.tokens = db.tokens.filter(
        (t) => t.userId !== account.user.id || t.token === token,
      );
      result = null;
    } else if (path === "/bookings" && method === "POST") {
      authorize(db, token, "driver");
      result = createBooking(db, account.user, body as BookingInput);
    } else if (/^\/bookings\/[^/]+\/cancel$/.test(path)) {
      authorize(db, token, "driver");
      const booking = db.bookings.find(
        (b) => b.id === path.split("/")[2] && b.userId === account.user.id,
      );
      if (!booking || booking.status !== "confirmed")
        throw new ApiError("Бронь уже отменена или использована.", 409);
      booking.status = "cancelled";
      returnPort(db, booking);
      result = booking;
    } else if (path === "/sessions" && method === "POST") {
      authorize(db, token, "driver");
      const booking = db.bookings.find(
        (b) =>
          b.id === (body as { bookingId: string }).bookingId &&
          b.userId === account.user.id,
      );
      if (!booking || booking.status !== "confirmed")
        throw new ApiError("Действующая бронь не найдена.", 404);
      if (
        db.sessions.some(
          (s) => s.userId === account.user.id && s.status === "active",
        )
      )
        throw new ApiError("Сначала завершите текущую зарядку.", 409);
      if (Date.parse(booking.start) > Date.now() + 15 * 60000)
        throw new ApiError(
          "Начать зарядку можно за 15 минут до времени брони.",
        );
      if (Date.parse(booking.start) + booking.duration * 60000 < Date.now())
        throw new ApiError("Время бронирования истекло. Создайте новую бронь.");
      const station = stationById(db, booking.stationId);
      if (["offline", "service"].includes(station.status))
        throw new ApiError("Станция сейчас недоступна.", 409);
      const connector = station.connectors.find(
        (c) => c.type === booking.connector,
      )!;
      const session: Session = {
        id: id(),
        bookingId: booking.id,
        userId: account.user.id,
        stationId: station.id,
        connector: booking.connector,
        startedAt: stamp(),
        meteredAt: stamp(),
        batteryCapacity: account.user.battery,
        endedAt: null,
        energy: 0,
        power: Math.min(connector.powerKw, station.limitKw / connector.total),
        initialCharge: 38,
        targetCharge: 80,
        tariff: station.pricePerKwh,
        status: "active",
      };
      booking.status = "used";
      db.sessions.unshift(session);
      event(db, "Начата зарядная сессия", station.id);
      result = session;
    } else if (/^\/sessions\/[^/]+\/stop$/.test(path)) {
      const session = db.sessions.find(
        (s) =>
          s.id === path.split("/")[2] &&
          (account.user.role === "operator" || s.userId === account.user.id),
      );
      if (!session || session.status !== "active")
        throw new ApiError("Активная сессия не найдена.", 409);
      const driver = db.accounts.find((a) => a.user.id === session.userId)!;
      session.energy = sessionMetrics(session, driver.user.battery).energy;
      session.status = "completed";
      session.endedAt = stamp();
      session.power = 0;
      const booking = db.bookings.find((b) => b.id === session.bookingId)!;
      returnPort(db, booking);
      event(db, "Зарядная сессия завершена", session.stationId);
      result = session;
    } else if (/^\/operator\/stations\/[^/]+$/.test(path)) {
      authorize(db, token, "operator");
      const station = stationById(db, path.split("/")[3]);
      const input = body as { limitKw?: number; service?: boolean };
      if (input.limitKw !== undefined) {
        if (
          !Number.isFinite(input.limitKw) ||
          input.limitKw < 120 ||
          input.limitKw > 600 ||
          input.limitKw % 20 !== 0
        )
          throw new ApiError("Допустимый лимит: 120–600 кВт, шаг 20 кВт.");
        if (
          db.stations.reduce(
            (sum, s) =>
              sum + (s.id === station.id ? input.limitKw! : s.limitKw),
            0,
          ) > db.networkLimit
        )
          throw new ApiError(
            "Сумма лимитов превышает выделенную мощность сети.",
            409,
          );
        station.limitKw = input.limitKw;
        db.sessions
          .filter((s) => s.stationId === station.id && s.status === "active")
          .forEach((s) => {
            const owner = db.accounts.find((a) => a.user.id === s.userId)!;
            s.energy = sessionMetrics(s, owner.user.battery).energy;
            s.meteredAt = stamp();
            s.power = Math.min(
              station.connectors.find((c) => c.type === s.connector)!.powerKw,
              station.limitKw /
                station.connectors.find((c) => c.type === s.connector)!.total,
            );
          });
        event(db, `Лимит мощности изменён: ${input.limitKw} кВт`, station.id);
      }
      if (input.service !== undefined) {
        if (
          input.service &&
          db.sessions.some(
            (s) => s.stationId === station.id && s.status === "active",
          )
        )
          throw new ApiError(
            "Завершите активные сессии перед переводом в сервис.",
            409,
          );
        station.status = input.service
          ? "service"
          : station.loadPercent === null
            ? "offline"
            : station.loadPercent >= 85
              ? "busy"
              : "available";
        event(
          db,
          input.service
            ? "Станция переведена в сервисный режим"
            : "Сервисный режим отключён",
          station.id,
        );
      }
      result = station;
    } else if (path === "/operator/network") {
      authorize(db, token, "operator");
      const input = body as { networkLimit: number };
      if (
        !Number.isFinite(input.networkLimit) ||
        input.networkLimit < 2000 ||
        input.networkLimit > 8000 ||
        input.networkLimit < db.stations.reduce((sum, s) => sum + s.limitKw, 0)
      )
        throw new ApiError(
          "Лимит должен покрывать мощность всех станций и быть в пределах 2–8 МВт.",
        );
      db.networkLimit = input.networkLimit;
      event(db, `Общий лимит сети изменён: ${input.networkLimit} кВт`);
      result = null;
    } else if (path === "/operator/organization") {
      authorize(db, token, "operator");
      const input = body as { name: string };
      if (input.name.trim().length < 3)
        throw new ApiError("Название должно содержать не менее 3 символов.");
      db.organization = input.name.trim();
      result = null;
    } else throw new ApiError("Действие не найдено.", 404);
  }
  save(db);
  return structuredClone(result) as T;
}
