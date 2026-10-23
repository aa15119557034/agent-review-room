/**
 * 在节点本机试跑一次（S-10 验收用）：不经过主控端，直接向本机 AgentServer 发一个 Prompt，
 * 把回复实时打印出来，最后打印结束方式。
 *
 *   pnpm --filter @room/agent-server run try -- deepseek-discuss "用一句话介绍你自己"
 *   pnpm --filter @room/agent-server run try -- codex-discuss "用一句话介绍你自己"
 *   pnpm --filter @room/agent-server run try -- codex-discuss --model gpt-6.1-sol --effort medium "用一句话介绍你自己"
 *
 * --model / --effort 走和主控端一样的 StartRun.model（S-22），不在配置清单里会被节点拒绝。
 * Token 从本机配置读取，不打印。AgentServer 需要先在另一个窗口里启动。
 */
import { createHash, randomInt } from "node:crypto";
import { RemoteEvent } from "@room/schemas";
import { loadConfig } from "./config";

const [profileId, ...rest] = process.argv.slice(2).filter((a) => a !== "--");
const options: Record<string, string> = {};
while (rest[0] === "--model" || rest[0] === "--effort") {
  const [flag, value] = rest.splice(0, 2);
  options[flag!.slice(2)] = value ?? "";
}
const prompt = rest.join(" ");
if (!profileId || !prompt || (options["effort"] !== undefined && options["model"] === undefined)) {
  console.error('用法：pnpm --filter @room/agent-server run try -- <profile> [--model <模型> [--effort <档位>]] "问题"');
  process.exit(2);
}
const model = options["model"] === undefined ? undefined : { model: options["model"], effort: options["effort"] ?? null };

let loaded: ReturnType<typeof loadConfig>;
try {
  loaded = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const { config, token } = loaded;
if (!config.profiles[profileId]) {
  console.error(`没有这个 profile：${profileId}。可用的：${Object.keys(config.profiles).join("、")}`);
  process.exit(2);
}
const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
const base = `http://${host}:${config.port}`;
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () => Array.from({ length: 26 }, () => ULID[randomInt(32)]).join("");
const runId = "run_" + ulid();

const started = Date.now();
let res: Response;
try {
  res = await fetch(`${base}/v1/runs`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      protocol: 1,
      runId,
      profileId,
      snapshot: { id: "snap_" + ulid(), content: prompt, contentHash: createHash("sha256").update(prompt, "utf8").digest("hex") },
      limits: { idleTimeoutMs: 300_000, totalTimeoutMs: 1_800_000 },
      ...(model ? { model } : {}),
    }),
  });
} catch {
  console.error(`连不上 ${base}。先在另一个窗口运行：pnpm --filter @room/agent-server run start`);
  process.exit(1);
}
if (res.status !== 202) {
  console.error(`启动失败：HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}

const events = await fetch(`${base}/v1/runs/${runId}/events?after=-1`, { headers: auth });
if (!events.ok || !events.body) {
  console.error(`读取事件失败：HTTP ${events.status}`);
  process.exit(1);
}

const decoder = new TextDecoder("utf-8");
let buffer = "";
let exitCode = 1;
for await (const chunk of events.body) {
  buffer += decoder.decode(chunk as Uint8Array, { stream: true });
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const e = RemoteEvent.parse(JSON.parse(line));
    if (e.type === "text_delta") process.stdout.write(e.text);
    else if (e.type === "output" && e.stream === "stderr") process.stderr.write(e.data);
    else if (e.type === "terminal") {
      const r = e.result;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`\n\n—— 结束：${r.outcome}${r.outcome === "error" ? `（${r.reason}${r.message ? "：" + r.message : ""}）` : ""}，用时 ${secs} 秒`);
      exitCode = r.outcome === "completed" ? 0 : 1;
    }
  }
}
process.exit(exitCode);
