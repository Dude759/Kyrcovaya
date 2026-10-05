import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { ErrorMessage } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { useAction } from "../hooks/useAction";
import { api } from "../services/api";
import { useApp } from "../state/context";
import type { Preferences } from "../types/domain";
import { money } from "../utils/format";

export function DriverProfilePage() {
  const { user, data, mutate } = useApp();
  const action = useAction();
  const finished = data!.sessions.filter((s) => s.status === "completed");
  const total = finished.reduce((sum, s) => sum + s.energy, 0);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await action.run(() =>
      mutate(
        () =>
          api.profile({
            name: String(form.get("name")),
            email: String(form.get("email")),
            phone: String(form.get("phone")),
            vehicle: String(form.get("vehicle")),
            plate: String(form.get("plate")),
            connector: form.get("connector") as "CCS2" | "CHAdeMO" | "Type 2",
            battery: Number(form.get("battery")),
          }),
        "Профиль сохранён",
      ),
    );
  }
  return (
    <AppShell
      role="driver"
      active="profile"
      title="Профиль"
      subtitle="Личные данные и параметры автомобиля"
    >
      <div className="account-layout">
        <form className="account-panel" onSubmit={save}>
          <div className="panel-title">
            <div>
              <span className="section-label">Личные данные</span>
              <h2>{user!.name}</h2>
              <p>Данные аккаунта и вашего автомобиля.</p>
            </div>
            <span className="profile-monogram">
              {user!.name
                .split(" ")
                .map((p) => p[0])
                .slice(0, 2)
                .join("")}
            </span>
          </div>
          <div className="field-grid">
            <label className="field">
              <span>Имя и фамилия</span>
              <input
                name="name"
                defaultValue={user!.name}
                minLength={2}
                required
              />
            </label>
            <label className="field">
              <span>Телефон</span>
              <input
                name="phone"
                type="tel"
                defaultValue={user!.phone}
                required
              />
            </label>
          </div>
          <label className="field">
            <span>Электронная почта</span>
            <input
              name="email"
              type="email"
              defaultValue={user!.email}
              required
            />
          </label>
          <hr />
          <div className="panel-title">
            <div>
              <span className="section-label">Автомобиль</span>
              <h2>{user!.vehicle || "Добавьте автомобиль"}</h2>
            </div>
            <span className="vehicle-tag">Основной</span>
          </div>
          <div className="field-grid">
            <label className="field">
              <span>Модель</span>
              <input name="vehicle" defaultValue={user!.vehicle} />
            </label>
            <label className="field">
              <span>Госномер</span>
              <input name="plate" defaultValue={user!.plate} />
            </label>
            <label className="field">
              <span>Тип разъёма</span>
              <select name="connector" defaultValue={user!.connector}>
                <option>CCS2</option>
                <option>CHAdeMO</option>
                <option>Type 2</option>
              </select>
            </label>
            <label className="field">
              <span>Ёмкость батареи · кВт⋅ч</span>
              <input
                name="battery"
                type="number"
                min={10}
                max={250}
                defaultValue={user!.battery}
                required
              />
            </label>
          </div>
          <ErrorMessage message={action.error} />
          <div className="form-actions">
            <button className="button" disabled={action.busy}>
              {action.busy ? "Сохраняем…" : "Сохранить профиль"}
            </button>
          </div>
        </form>
        <aside className="account-summary">
          <span className="section-label section-label--light">
            За всё время
          </span>
          <strong>{total.toFixed(1)} кВт⋅ч</strong>
          <small>получено энергии</small>
          <dl>
            <div>
              <dt>Сессий</dt>
              <dd>{finished.length}</dd>
            </div>
            <div>
              <dt>Расходы</dt>
              <dd>
                {money(
                  finished.reduce((sum, s) => sum + s.energy * s.tariff, 0),
                )}
              </dd>
            </div>
            <div>
              <dt>Средняя сессия</dt>
              <dd>
                {finished.length ? (total / finished.length).toFixed(1) : "0"}{" "}
                кВт⋅ч
              </dd>
            </div>
          </dl>
          <Link className="text-link text-link--light" to="/driver/sessions">
            История зарядок →
          </Link>
        </aside>
      </div>
    </AppShell>
  );
}

function PreferenceRow({
  title,
  text,
  name,
}: {
  title: string;
  text: string;
  name: keyof Preferences;
}) {
  const { data, mutate } = useApp();
  const action = useAction();
  return (
    <>
      <label className="preference-row">
        <span>
          <strong>{title}</strong>
          <small>{text}</small>
        </span>
        <input
          type="checkbox"
          checked={data!.preferences[name]}
          disabled={action.busy}
          onChange={(e) => {
            const value = e.target.checked;
            void action.run(() =>
              mutate(
                () => api.preferences({ [name]: value }),
                "Настройка сохранена",
              ),
            );
          }}
        />
        <i aria-hidden="true" />
      </label>
      <ErrorMessage message={action.error} />
    </>
  );
}
function PasswordForm({ onClose }: { onClose: () => void }) {
  const { mutate } = useApp();
  const action = useAction();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("next") !== form.get("repeat")) {
      action.setError("Новые пароли не совпадают.");
      return;
    }
    await action.run(async () => {
      await mutate(
        () =>
          api.password(String(form.get("current")), String(form.get("next"))),
        "Пароль изменён",
      );
      onClose();
    });
  }
  return (
    <Modal title="Изменить пароль" onClose={() => !action.busy && onClose()}>
      <form onSubmit={submit}>
        <label className="field">
          <span>Текущий пароль</span>
          <input
            name="current"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <label className="field">
          <span>Новый пароль · от 8 символов</span>
          <input
            name="next"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <label className="field">
          <span>Повторите новый пароль</span>
          <input
            name="repeat"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <ErrorMessage message={action.error} />
        <button className="button button--full" disabled={action.busy}>
          {action.busy ? "Сохраняем…" : "Изменить пароль"}
        </button>
      </form>
    </Modal>
  );
}
export function DriverSettingsPage() {
  const [password, setPassword] = useState(false);
  const [payment, setPayment] = useState(false);
  return (
    <AppShell
      role="driver"
      active="settings"
      title="Настройки"
      subtitle="Уведомления, оплата и безопасность"
    >
      <div className="settings-stack">
        <section className="preference-panel">
          <div className="panel-title">
            <div>
              <span className="section-label">Уведомления</span>
              <h2>Каналы связи</h2>
            </div>
          </div>
          <PreferenceRow
            name="bookingAlerts"
            title="Бронирования и сессии"
            text="Напоминания о времени брони и завершении зарядки"
          />
          <PreferenceRow
            name="receipts"
            title="Документы о зарядке"
            text="Сохранять документы для отправки на почту"
          />
          <PreferenceRow
            name="networkAlerts"
            title="Состояние сети"
            text="Новости станций и технических работ"
          />
        </section>
        <section className="preference-panel">
          <div className="panel-title">
            <div>
              <span className="section-label">Оплата</span>
              <h2>Карта или СБП</h2>
              <p>Способ оплаты выбирается при бронировании.</p>
            </div>
          </div>
          <button
            className="button button--outline"
            onClick={() => setPayment(true)}
          >
            Как работает оплата
          </button>
        </section>
        <section className="preference-panel preference-panel--danger">
          <div>
            <span className="section-label">Безопасность</span>
            <h2>Управление аккаунтом</h2>
            <p>Измените пароль для доступа к личному кабинету.</p>
          </div>
          <button
            className="button button--outline"
            onClick={() => setPassword(true)}
          >
            Изменить пароль
          </button>
        </section>
      </div>
      {password && <PasswordForm onClose={() => setPassword(false)} />}
      {payment && (
        <Modal title="Оплата зарядки" onClose={() => setPayment(false)}>
          <p>
            При бронировании выберите карту или СБП. В демонстрационном режиме
            платежи тестовые: реквизиты не запрашиваются, деньги не списываются.
          </p>
          <p>
            Реальный платёжный сервис подключается через сервер. После
            завершения зарядки доступен отчёт о сессии.
          </p>
          <button
            className="button button--full"
            onClick={() => setPayment(false)}
          >
            Понятно
          </button>
        </Modal>
      )}
    </AppShell>
  );
}
export function OperatorSettingsPage() {
  const { data, mutate } = useApp();
  const action = useAction();
  const [password, setPassword] = useState(false);
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("organization"));
    void action.run(() =>
      mutate(() => api.organization(name), "Настройки организации сохранены"),
    );
  }
  return (
    <AppShell
      role="operator"
      active="settings"
      title="Настройки организации"
      subtitle="Параметры рабочей области и оповещения"
    >
      <div className="settings-stack">
        <form className="preference-panel" onSubmit={save}>
          <div className="panel-title">
            <div>
              <span className="section-label">Организация</span>
              <h2>{data!.organization}</h2>
            </div>
          </div>
          <div className="field-grid">
            <label className="field">
              <span>Название</span>
              <input
                name="organization"
                defaultValue={data!.organization}
                minLength={3}
                required
              />
            </label>
            <label className="field">
              <span>Часовой пояс</span>
              <select aria-label="Часовой пояс" disabled>
                <option>Москва, UTC+3</option>
              </select>
            </label>
          </div>
          <ErrorMessage message={action.error} />
          <div className="form-actions">
            <button className="button" disabled={action.busy}>
              {action.busy ? "Сохраняем…" : "Сохранить"}
            </button>
          </div>
        </form>
        <section className="preference-panel">
          <div className="panel-title">
            <div>
              <span className="section-label">Оповещения</span>
              <h2>События сети</h2>
            </div>
          </div>
          <PreferenceRow
            name="criticalAlerts"
            title="Критические события"
            text="Нет связи и аварийная остановка"
          />
          <PreferenceRow
            name="loadAlerts"
            title="Превышение нагрузки"
            text="Предупреждать при достижении 85% лимита"
          />
          <PreferenceRow
            name="reports"
            title="Еженедельный отчёт"
            text="Подготовка сводки по понедельникам"
          />
        </section>
        <section className="preference-panel">
          <h2>Безопасность</h2>
          <button
            className="button button--outline"
            onClick={() => setPassword(true)}
          >
            Изменить пароль
          </button>
        </section>
      </div>
      {password && <PasswordForm onClose={() => setPassword(false)} />}
    </AppShell>
  );
}
