import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../../middleware/errors.js";
import type { TestEvent } from "./validation.js";

export type PaymentOptions = {
  publicOrigin: string;
  secret: string;
  holdTtlSeconds?: number;
};
export function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
function mac(secret: string, value: string | Buffer) {
  return createHmac("sha256", secret).update(value).digest("hex");
}
function equal(a: string, b: string) {
  return (
    /^[a-f0-9]{64}$/.test(a) &&
    /^[a-f0-9]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  );
}
export function checkoutToken(options: PaymentOptions, attemptId: string) {
  return mac(options.secret, `checkout:${attemptId}`);
}
export function confirmationUrl(
  options: PaymentOptions,
  attemptId: string,
  base?: string,
) {
  const url = new URL(
    base ?? `${options.publicOrigin}/api/test-payments/${attemptId}`,
  );
  url.searchParams.set("token", checkoutToken(options, attemptId));
  return url.toString();
}
export function verifyCheckout(
  options: PaymentOptions,
  attemptId: string,
  token: unknown,
) {
  if (
    typeof token !== "string" ||
    !equal(token, checkoutToken(options, attemptId))
  )
    throw new HttpError(401, "Недействительная ссылка тестового провайдера.");
}
export function signEvent(
  options: PaymentOptions,
  event: TestEvent,
  timestamp = String(Math.floor(Date.now() / 1000)),
) {
  const body = Buffer.from(JSON.stringify(event));
  return {
    body,
    timestamp,
    signature: mac(
      options.secret,
      Buffer.concat([Buffer.from(`${timestamp}.`), body]),
    ),
  };
}
export function verifyEvent(
  options: PaymentOptions,
  body: Buffer,
  timestamp: unknown,
  signature: unknown,
) {
  if (
    typeof timestamp !== "string" ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    typeof signature !== "string" ||
    !equal(
      signature,
      mac(options.secret, Buffer.concat([Buffer.from(`${timestamp}.`), body])),
    )
  )
    throw new HttpError(401, "Подпись события недействительна или устарела.");
}
