import type { ControlErrorCode } from "@room/schemas";

/** mock 共用的小工具 */

export class MockError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let counter = 0;
/** 足够用的 ULID：时间前缀 + 单调计数，保证同一毫秒内也有序 */
function ulid(): string {
  const now = Date.now();
  counter = now === lastTime ? counter + 1 : 0;
  lastTime = now;
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = counter.toString(32).toUpperCase().padStart(4, "0").replace(/[ILOU]/g, "X");
  while (rand.length < 16) rand += CROCKFORD[Math.floor(Math.random() * 32)];
  return time + rand.slice(0, 16);
}
export const id = (prefix: string) => `${prefix}_${ulid()}`;
export const now = () => new Date().toISOString();

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

