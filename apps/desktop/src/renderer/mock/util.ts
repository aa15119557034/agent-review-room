import type { ControlErrorCode } from "@room/schemas";
import { newId } from "../lib/ids";

/** mock 共用的小工具 */

export class MockError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const id = newId;
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
