/**
 * 带前缀的 ULID（契约 prefixedId 的格式）：时间前缀 + 单调计数，同一毫秒内也有序。
 * 聊天消息的 id 由发送方生成（chat.send 防重复），所以 renderer 也要能造；mock 共用这一份。
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let counter = 0;

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
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (let i = 0; rand.length < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return time + rand.slice(0, 16);
}

export const newId = (prefix: string) => `${prefix}_${ulid()}`;
