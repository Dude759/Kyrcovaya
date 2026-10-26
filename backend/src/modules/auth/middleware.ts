import type { RequestHandler } from "express";
import type { Database } from "../../db/pool.js";
import { HttpError } from "../../middleware/errors.js";
import { hashToken } from "./security.js";

export type Identity = {
  id: string;
  role: "driver" | "operator";
  organizationId: string | null;
  sessionId: string;
};
declare global {
  namespace Express {
    interface Request {
      identity?: Identity;
    }
  }
}

export function authenticate(pool: Database): RequestHandler {
  return async (req, _res, next) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
      req.headers.authorization ?? "",
    );
    if (!match) throw new HttpError(401, "Необходимо войти в аккаунт.");
    const { rows } = await pool.query(
      `SELECT u.id,u.role,u.organization_id AS "organizationId",s.id AS "sessionId"
      FROM auth_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`,
      [hashToken(match[1])],
    );
    if (!rows[0]) throw new HttpError(401, "Сессия завершена. Войдите снова.");
    req.identity = rows[0];
    next();
  };
}
export const operatorOnly: RequestHandler = (req, _res, next) => {
  if (req.identity?.role !== "operator")
    throw new HttpError(403, "Доступно только оператору.");
  next();
};
