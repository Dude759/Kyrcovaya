import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { HttpError } from "../../middleware/errors.js";

const N = 131072,
  r = 8,
  p = 1;
let hashing = false;
const queue: Array<() => void> = [];
async function derive(password: string, salt: string) {
  // One 128 MiB scrypt at a time fits a 512 MiB demo instance; bound waiting work.
  if (hashing) {
    if (queue.length >= 8)
      throw new HttpError(
        503,
        "Сервис входа занят. Повторите попытку чуть позже.",
      );
    await new Promise<void>((resolve) => queue.push(resolve));
  } else hashing = true;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        64,
        { N, r, p, maxmem: 256 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      );
    });
  } finally {
    const next = queue.shift();
    if (next) next();
    else hashing = false;
  }
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${N}$${r}$${p}$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [algorithm, n, cost, parallel, salt, hex] = stored.split("$");
  if (
    algorithm !== "scrypt" ||
    Number(n) !== N ||
    Number(cost) !== r ||
    Number(parallel) !== p ||
    !salt ||
    !/^[a-f0-9]{128}$/.test(hex ?? "")
  )
    return false;
  return timingSafeEqual(await derive(password, salt), Buffer.from(hex, "hex"));
}
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
