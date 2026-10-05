import { createContext, useContext } from "react";
import type { AuthResult, Snapshot, User } from "../types/domain";
export type AppState = {
  user: User | null;
  data: Snapshot | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  authenticate: (result: AuthResult, remember?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  mutate: <T>(operation: () => Promise<T>, message?: string) => Promise<T>;
  notify: (message: string) => void;
};
export const Context = createContext<AppState | null>(null);

export function useApp() {
  const context = useContext(Context);
  if (!context) throw new Error("AppProvider missing");
  return context;
}
