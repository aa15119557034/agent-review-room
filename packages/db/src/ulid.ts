import { randomBytes } from "node:crypto";

/**
 * ULID（D-02）：26 个 Crockford Base32 字符 = 48 位毫秒时间戳 + 80 位随机数。
 *
 * 为什么不用 uuid：本项目的列表几乎都按创建时间排序（Run 历史、Contribution），
 * ULID 的字典序就是时间序，索引无需额外列；同毫秒内用递增保证不重复且仍有序。
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

let lastTime = -1;
let lastRandom = "";

function encodeTime(ms: number): string {
  let rest = ms;
  let out = "";
  for (let index = 0; index < TIME_CHARS; index++) {
    out = ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function randomChars(): string {
  const bytes = randomBytes(RANDOM_CHARS);
  let out = "";
  for (let index = 0; index < RANDOM_CHARS; index++) {
    out += ALPHABET[bytes[index]! % 32];
  }
  return out;
}

/** 在 Base32 字符串上 +1；溢出返回 null（同一毫秒内 32^16 次才会发生）。 */
function increment(chars: string): string | null {
  const buffer = chars.split("");
  for (let index = buffer.length - 1; index >= 0; index--) {
    const current = ALPHABET.indexOf(buffer[index]!);
    if (current < 31) {
      buffer[index] = ALPHABET[current + 1]!;
      return buffer.join("");
    }
    buffer[index] = ALPHABET[0]!;
  }
  return null;
}

/**
 * 生成一个 ULID。单调：同一毫秒内递增，时钟回拨时沿用上次的时间戳。
 * @param now - 注入的当前时间（测试用）
 */
export function ulid(now: number = Date.now()): string {
  const millis = Math.max(Math.floor(now), lastTime);
  let random: string | null;

  if (millis === lastTime) {
    random = increment(lastRandom);
    if (random === null) throw new RangeError("ULID randomness exhausted within one millisecond");
  } else {
    random = randomChars();
  }

  lastTime = millis;
  lastRandom = random;
  return encodeTime(millis) + random;
}

/** 校验 ULID 字面量（长度 + 字符集）。 */
export function isUlid(value: string): boolean {
  if (value.length !== TIME_CHARS + RANDOM_CHARS) return false;
  for (const char of value) {
    if (!ALPHABET.includes(char)) return false;
  }
  return true;
}
