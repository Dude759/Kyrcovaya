import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BrandMark } from "../components/BrandMark";
import { ErrorMessage } from "../components/Feedback";
import { useAction } from "../hooks/useAction";
import { api, apiMode } from "../services/api";
import type { RecoveryResult } from "../types/domain";

function AccessLayout({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="access-layout">
      <Link className="wordmark" to="/">
        <BrandMark size={36} />
        <span>Энерготранспорт</span>
      </Link>
      <section className="access-card">
        <span className="eyebrow">ЛИЧНЫЙ КАБИНЕТ</span>
        <h1>{title}</h1>
        {children}
      </section>
      <p className="access-footer">Управление зарядной инфраструктурой</p>
    </main>
  );
}

export function RecoveryPage() {
  const [result, setResult] = useState<RecoveryResult | null>(null);
  const action = useAction();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email"));
    await action.run(async () => setResult(await api.recover(email)));
  }
  return (
    <AccessLayout
      title={
        result
          ? apiMode === "mock"
            ? "Тестовая ссылка"
            : "Проверьте почту"
          : "Восстановление доступа"
      }
    >
      {result ? (
        <>
          <p role="status">{result.message} Ссылка действует 30 минут.</p>
          {apiMode === "mock" && (
            <div className="demo-note">
              <strong>Демонстрационный режим</strong>
              <p>
                Письма не отправляются. Для аккаунта в этом браузере можно
                открыть тестовую ссылку ниже.
              </p>
              {result.demoResetToken && (
                <Link
                  className="text-link"
                  to={`/reset-password?token=${encodeURIComponent(result.demoResetToken)}`}
                >
                  Открыть тестовую ссылку →
                </Link>
              )}
            </div>
          )}
          <button
            className="button button--outline button--full"
            onClick={() => setResult(null)}
          >
            Указать другую почту
          </button>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <p>
            Укажите почту, которую использовали при входе. Мы поможем
            восстановить доступ.
          </p>
          <label className="field">
            <span>Электронная почта</span>
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <ErrorMessage message={action.error} />
          <button className="button button--full" disabled={action.busy}>
            {action.busy ? "Отправляем…" : "Получить ссылку"}
          </button>
          {apiMode === "mock" && (
            <p className="demo-note">
              Демонстрация восстановления · без отправки писем.
            </p>
          )}
        </form>
      )}
      <Link className="access-back" to="/login">
        ← Вернуться ко входу
      </Link>
    </AccessLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [done, setDone] = useState(false);
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
      await api.resetPassword(token!, password);
      setDone(true);
    });
  }
  return (
    <AccessLayout title={done ? "Пароль обновлён" : "Новый пароль"}>
      {done ? (
        <>
          <p role="status">
            Войдите с новым паролем. Предыдущие сессии входа завершены.
          </p>
          <Link className="button button--full" to="/login">
            Перейти ко входу
          </Link>
        </>
      ) : !token ? (
        <>
          <p role="alert">
            В ссылке нет кода восстановления. Запросите новую ссылку.
          </p>
          <Link className="button button--full" to="/forgot-password">
            Восстановить доступ
          </Link>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <p>
            Не менее 8 символов. Используйте пароль, который не повторяется в
            других сервисах.
          </p>
          <label className="field">
            <span>Новый пароль</span>
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </label>
          <label className="field">
            <span>Повторите пароль</span>
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
            {action.busy ? "Сохраняем…" : "Сохранить пароль"}
          </button>
          {action.error && (
            <Link className="access-back" to="/forgot-password">
              Запросить новую ссылку
            </Link>
          )}
          {apiMode === "mock" && (
            <p className="demo-note">
              Изменяется только пароль локального тестового аккаунта.
            </p>
          )}
        </form>
      )}
    </AccessLayout>
  );
}
