import { Context, useApp } from "./context";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { api, getToken, setToken } from "../services/api";
import { ApiError, errorMessage } from "../services/errors";
import type { AuthResult, Role, Snapshot, User } from "../types/domain";

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setError("");
    if (!getToken()) {
      setUser(null);
      setData(null);
      setLoading(false);
      return;
    }
    try {
      const [nextUser, nextData] = await Promise.all([
        api.me(),
        api.workspace(),
      ]);
      if (current === generation.current) {
        setUser(nextUser);
        setData(nextData);
      }
    } catch (err) {
      if (current !== generation.current) return;
      if (err instanceof ApiError && err.status === 401) {
        setToken(null);
        setUser(null);
        setData(null);
      } else setError(errorMessage(err));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);
  useEffect(() => {
    const sync = () => {
      void refresh();
    };
    window.addEventListener("storage", sync);
    window.addEventListener("focus", sync);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && getToken()) sync();
    }, 30000);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("focus", sync);
      window.clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  async function authenticate(result: AuthResult, remember = true) {
    setToken(result.token, remember);
    setUser(result.user);
    await refresh();
  }
  async function logout() {
    try {
      await api.logout();
    } finally {
      generation.current++;
      setToken(null);
      setUser(null);
      setData(null);
    }
  }
  async function mutate<T>(operation: () => Promise<T>, message = "") {
    try {
      const result = await operation();
      await refresh();
      if (message) setToast(message);
      return result;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setToken(null);
        setUser(null);
        setData(null);
      }
      throw err;
    }
  }
  return (
    <Context.Provider
      value={{
        user,
        data,
        loading,
        error,
        refresh,
        authenticate,
        logout,
        mutate,
        notify: setToast,
      }}
    >
      {children}
      {toast && (
        <div className="app-toast" role="status">
          {toast}
          <button onClick={() => setToast("")} aria-label="Закрыть уведомление">
            ×
          </button>
        </div>
      )}
    </Context.Provider>
  );
}
export function ProtectedRoute({ role }: { role: Role }) {
  const { user, data, loading, error, refresh } = useApp();
  const location = useLocation();
  if (loading)
    return (
      <div className="route-state" role="status">
        Загружаем рабочую область…
      </div>
    );
  if (error && !data)
    return (
      <div className="route-state" role="alert">
        <h1>Не удалось загрузить данные</h1>
        <p>{error}</p>
        <button className="button" onClick={() => void refresh()}>
          Повторить
        </button>
      </div>
    );
  if (!user)
    return (
      <Navigate
        to={`/login?role=${role}`}
        state={{ from: location.pathname + location.search }}
        replace
      />
    );
  if (user.role !== role)
    return (
      <Navigate
        to={user.role === "operator" ? "/operator" : "/driver/stations"}
        replace
      />
    );
  if (!data)
    return (
      <div className="route-state" role="status">
        Загружаем данные…
      </div>
    );
  return <Outlet />;
}
