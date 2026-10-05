import { useState } from "react";
import type { FormEvent } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { BrandMark } from "../components/BrandMark";
import { ErrorMessage } from "../components/Feedback";
import { useAction } from "../hooks/useAction";
import { api, apiMode } from "../services/api";
import { demoAccounts } from "../services/mockApi";
import { useApp } from "../state/context";
import type { Role } from "../types/domain";

export function LoginPage() {
  const [params] = useSearchParams();
  const [role, setRole] = useState<Role>(
    params.get("role") === "operator" ? "operator" : "driver",
  );

  const action = useAction();
  const { authenticate } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await action.run(async () => {
      const result = await api.login({
        email: String(form.get("email")),
        password: String(form.get("password")),
        role,
      });
      await authenticate(result, form.get("remember") === "on");
      const from = (location.state as { from?: string } | null)?.from;
      navigate(
        from?.startsWith(`/${role}/`) ||
          (role === "operator" && from === "/operator")
          ? from
          : role === "operator"
            ? "/operator"
            : "/driver/stations",
        { replace: true },
      );
    });
  }
  return (
    <main className="auth-layout">
      <section className="auth-brand">
        <Link className="wordmark wordmark--light" to="/">
          <BrandMark size={48} tone="green" />
          <span>Энерготранспорт</span>
        </Link>
        <div className="auth-brand__copy">
          <h1>
            Управляйте зарядкой
            <br />
            без лишних действий
          </h1>
          <p>
            Единая точка входа для водителей
            <br />и операторов инфраструктуры.
          </p>
        </div>
        <div className="auth-network">
          <span>Ваша рабочая область</span>
          <strong>Зарядная сеть Москвы</strong>
          <small>Станции, бронирования и управление мощностью</small>
        </div>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-card" onSubmit={submit}>
          <h2>Вход в систему</h2>
          <p>Выберите тип учётной записи</p>
          <div className="role-tabs" aria-label="Тип учётной записи">
            {(["driver", "operator"] as const).map((value) => (
              <button
                type="button"
                aria-pressed={role === value}
                className={role === value ? "is-active" : ""}
                key={value}
                onClick={() => {
                  setRole(value);
                  action.setError("");
                }}
              >
                <strong>{value === "driver" ? "Водитель" : "Оператор"}</strong>
                <small>
                  {value === "driver"
                    ? "Поиск и зарядка автомобиля"
                    : "Управление инфраструктурой"}
                </small>
              </button>
            ))}
          </div>
          <label className="field">
            <span>Электронная почта</span>
            <input
              key={role}
              name="email"
              type="email"
              autoComplete="username"
              defaultValue={apiMode === "mock" ? demoAccounts[role] : ""}
              required
            />
          </label>
          <label className="field">
            <span>Пароль</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              defaultValue={apiMode === "mock" ? demoAccounts.password : ""}
              required
            />
          </label>
          <div className="form-meta">
            <label>
              <input name="remember" type="checkbox" defaultChecked /> Запомнить
              меня
            </label>
            <Link to="/forgot-password">Восстановить пароль</Link>
          </div>
          <ErrorMessage message={action.error} />
          <button className="button button--full" disabled={action.busy}>
            {action.busy ? "Входим…" : "Войти"}
          </button>
          {role === "driver" && (
            <>
              <div className="or">
                <span>или</span>
              </div>
              <p className="register-link">
                Нет аккаунта? <Link to="/register">Зарегистрироваться</Link>
              </p>
            </>
          )}
          <small className="operator-hint">
            Доступ оператору выдаёт администратор организации.
          </small>
          {apiMode === "mock" && (
            <p className="demo-note">
              Демонстрационный режим · данные сохраняются в этом браузере.
              <br />
              Тестовый пароль: {demoAccounts.password}
            </p>
          )}
        </form>
      </section>
    </main>
  );
}

export function RegisterPage() {
  const { authenticate } = useApp();
  const navigate = useNavigate();
  const action = useAction();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    if (password !== form.get("repeat")) {
      action.setError("Пароли не совпадают.");
      return;
    }
    await action.run(async () => {
      const result = await api.register({
        name: String(form.get("name")),
        email: String(form.get("email")),
        phone: String(form.get("phone")),
        password,
        vehicle: String(form.get("vehicle")),
        plate: "",
        connector: "CCS2",
        battery: 100,
      });
      await authenticate(result);
      navigate("/driver/stations");
    });
  }
  return (
    <main className="register-layout">
      <form className="register-card" onSubmit={submit}>
        <Link className="text-link" to="/">
          ← Главная
        </Link>
        <h1>Регистрация водителя</h1>
        <p>Создайте личный аккаунт для бронирования зарядки</p>
        <div className="account-note">
          <strong>Личный аккаунт водителя</strong>
          <small>Операторские аккаунты создаёт администратор организации</small>
        </div>
        <div className="field-grid">
          <label className="field">
            <span>Имя и фамилия</span>
            <input name="name" autoComplete="name" minLength={2} required />
          </label>
          <label className="field">
            <span>Телефон</span>
            <input
              name="phone"
              autoComplete="tel"
              type="tel"
              placeholder="+7 999 000-00-00"
              required
            />
          </label>
        </div>
        <label className="field">
          <span>Электронная почта</span>
          <input name="email" autoComplete="email" type="email" required />
        </label>
        <div className="field-grid">
          <label className="field">
            <span>Пароль · от 8 символов</span>
            <input
              name="password"
              autoComplete="new-password"
              type="password"
              minLength={8}
              required
            />
          </label>
          <label className="field">
            <span>Повторите пароль</span>
            <input
              name="repeat"
              autoComplete="new-password"
              type="password"
              minLength={8}
              required
            />
          </label>
        </div>
        <label className="field">
          <span>Автомобиль (необязательно)</span>
          <input name="vehicle" placeholder="Например, Zeekr 001" />
        </label>
        <label className="agreement">
          <input type="checkbox" required /> Согласен на обработку данных для
          работы сервиса
        </label>
        <ErrorMessage message={action.error} />
        <button className="button button--full" disabled={action.busy}>
          {action.busy ? "Создаём аккаунт…" : "Создать аккаунт"}
        </button>
        <p className="register-link">
          Уже зарегистрированы? <Link to="/login">Войти</Link>
        </p>
      </form>
      <aside className="vehicle-panel">
        <span className="section-label section-label--light">
          Профиль автомобиля
        </span>
        <h2>
          Сохраните автомобиль
          <br />
          один раз
        </h2>
        <p>
          Выбирайте подходящие разъёмы и следите за зарядкой в личном кабинете.
        </p>
        <dl>
          <div>
            <dt>Модель</dt>
            <dd>Zeekr 001</dd>
          </div>
          <div>
            <dt>Разъём</dt>
            <dd>CCS2</dd>
          </div>
          <div>
            <dt>Ёмкость батареи</dt>
            <dd>100 кВт⋅ч</dd>
          </div>
        </dl>
        <div className="operator-access">
          <strong>Доступ оператора</strong>
          <p>Логин и роль выдаёт администратор вашей организации.</p>
          <Link to="/login?role=operator">Вход для операторов →</Link>
        </div>
      </aside>
    </main>
  );
}
export function NotFoundPage() {
  return (
    <main className="not-found">
      <h1>Страница не найдена</h1>
      <p>Проверьте адрес или вернитесь на главную.</p>
      <Link className="button" to="/">
        На главную
      </Link>
    </main>
  );
}
