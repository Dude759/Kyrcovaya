import type { Booking } from "../types/domain";
export function bookingLabel(b: Booking) {
  return b.status === "expired"
    ? "Истекла из-за неявки"
    : b.status === "used"
      ? "Использована"
      : b.status === "confirmed"
        ? "Подтверждена"
        : b.closureReason === "driver"
          ? "Отменена водителем"
          : b.closureReason === "session"
            ? "Завершена без запуска"
            : "Отменена";
}
