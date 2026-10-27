import type { Session } from "../types/domain";
export const serverSessionLabels: Record<Session["status"], string> = {
  starting: "Ожидаем подтверждения запуска",
  active: "Зарядка идёт",
  stopping: "Ожидаем подтверждения остановки",
  completed: "Зарядка завершена",
  failed: "Запуск отклонён",
};
