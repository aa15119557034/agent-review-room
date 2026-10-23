#!/usr/bin/env node
// DeepSeek 讨论用的小程序（S-10）。由 AgentServer 的 deepseek-discuss profile 启动：
//
//   node ../bin/deepseek-chat.mjs --model deepseek-flash --effort high
//
// - --model 默认 deepseek-flash；--effort 原样作为 reasoning_effort 发出，不传就用接口默认（S-22 实测：
//   deepseek-flash / deepseek-v4-pro 的档位是 low / high / max，默认 high，错的档位接口直接报错）
// - 从 stdin 读完整的 Prompt（主控端拼好、用户盖过章的内容），原样作为一条 user 消息发出
// - API Key 只从本机环境变量 DEEPSEEK_API_KEY 读取；不打印、不写文件、不回传
// - stdout 每行一个 JSON（格式见 src/parsers/room-jsonl.ts）：delta / done / error
// - 402（余额不足）和 429（限流）报告为 quota=true，讨论里显示为「缺席（额度）」
//
// 只用 Node 自带的 fetch，不依赖任何 npm 包，方便在节点上直接运行。

const args = parseArgs(process.argv.slice(2));
const model = args.model ?? "deepseek-flash";
const effort = args.effort || undefined;
const baseUrl = (args["base-url"] ?? "https://api.deepseek.com").replace(/\/+$/, "");
const maxTokens = args["max-tokens"] ? Number(args["max-tokens"]) : undefined;

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const fail = (message, quota = false) => {
  out({ type: "error", message, quota });
  process.exitCode = 1;
};

main().catch((err) => fail(`内部错误：${err instanceof Error ? err.message : String(err)}`));

async function main() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return fail("这台电脑上没有设置 DEEPSEEK_API_KEY 环境变量");

  const prompt = await readStdin();
  if (!prompt.trim()) return fail("Prompt 是空的");

  // 主控端取消时 AgentServer 会杀掉本进程，连接随之断开，不需要自己处理 abort
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        ...(effort ? { reasoning_effort: effort } : {}),
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      }),
    });
  } catch (err) {
    return fail(`连不上 DeepSeek：${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    const quota = res.status === 402 || res.status === 429;
    const label = { 401: "API Key 无效", 402: "余额不足", 429: "请求太频繁（限流）" }[res.status] ?? "请求失败";
    return fail(`DeepSeek ${res.status} ${label}${detail ? "：" + detail : ""}`, quota);
  }
  if (!res.body) return fail("DeepSeek 没有返回内容");

  let text = "";
  let finishReason = null;
  let sawDone = false;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue; // 空行、": keep-alive" 注释
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        sawDone = true;
        continue;
      }
      let obj;
      try {
        obj = JSON.parse(data);
      } catch {
        continue;
      }
      if (obj.error) return fail(`DeepSeek 返回错误：${obj.error.message ?? JSON.stringify(obj.error)}`.slice(0, 1000));
      const choice = obj.choices?.[0];
      // reasoning_content 是思考过程，不算回答；只转发 content
      const piece = choice?.delta?.content;
      if (typeof piece === "string" && piece) {
        text += piece;
        out({ type: "delta", text: piece });
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  }

  if (!sawDone && !finishReason) return fail("DeepSeek 的回复在结束之前中断");
  if (finishReason === "insufficient_system_resource") return fail("DeepSeek 服务端资源不足，回复被中断");
  out({ type: "done", text, finishReason });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => resolve(s));
    process.stdin.on("error", reject);
  });
}

function parseArgs(list) {
  const o = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith("--")) o[a.slice(2)] = list[i + 1] ?? "";
    if (a.startsWith("--")) i++;
  }
  return o;
}
