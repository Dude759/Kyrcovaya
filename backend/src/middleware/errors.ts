import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ message: error.message });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ message: "Проверьте поля запроса." });
    return;
  }
  if (error?.type === "entity.parse.failed") {
    res.status(400).json({ message: "Некорректный JSON." });
    return;
  }
  if (error?.type === "entity.too.large") {
    res.status(413).json({ message: "Запрос слишком большой." });
    return;
  }
  if (error?.code === "23505") {
    res
      .status(409)
      .json({ message: "Запись с такими данными уже существует." });
    return;
  }
  if (["23514", "23503", "22P02", "22003"].includes(error?.code)) {
    res
      .status(400)
      .json({ message: "Недопустимые значения или связь объектов." });
    return;
  }
  // Never log the error object: pg errors may contain passwords, SQL values or PII.
  console.error("Unhandled server error");
  res.status(500).json({ message: "Ошибка сервера. Повторите попытку." });
};
