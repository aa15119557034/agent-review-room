#!/usr/bin/env node
// P2-S07: one approved query -> one Search -> at most one Fetch. No model loop.
// The full fetched body is the authoritative done.text; citation metadata never replaces it.
import { createHash } from "node:crypto";
import { isIP } from "node:net";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_BYTES = 512 * 1024;
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const display = (block) => out({ type: "result_display", result: { version: 1, block } });
const unknown = { status: "unknown", reason: "not_reported" };
let toolCalls = 0;

class ToolFailure extends Error {
  constructor(message, quota = false) { super(message); this.quota = quota; }
}

function baseUrl() {
  const args = process.argv.slice(2);
  if (args.length === 0) return "https://api.deepseek.com";
  // Explicit node-local test endpoint; never taken from a remote request or search result.
  if (args.length !== 2 || args[0] !== "--base-url") throw new ToolFailure("不支持的检索参数");
  const url = new URL(args[1]);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.origin === "https://api.deepseek.com" || (url.protocol === "http:" && url.hostname === "127.0.0.1"))) {
    throw new ToolFailure("检索服务只允许官方 HTTPS 地址或显式本机测试端点");
  }
  return url.origin;
}

function pageUrl(value) {
  if (typeof value !== "string" || value.length > 8192) throw new ToolFailure("搜索结果包含无效的网址");
  let url;
  try { url = new URL(value); } catch { throw new ToolFailure("搜索结果包含无效的网址"); }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port ||
      isIP(host) || !host.includes(".") || /(^|\.)(localhost|local|internal|lan|home|onion)$/.test(host)) {
    throw new ToolFailure("首片只读取公开网站域名，不接受凭据、IP 地址、内网名称或非标准端口");
  }
  // The node calls the fixed provider API, never the page URL. The provider enforces
  // destination/redirect policy (403); this syntax check is not DNS or access authorization.
  return url.href;
}

async function request(base, key, endpoint, body) {
  toolCalls++;
  let response;
  try {
    response = await fetch(base + endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify(body),
    });
  } catch { throw new ToolFailure("检索服务连接失败或超时；服务端是否计费未知"); }
  if (!response.ok) {
    await response.body?.cancel();
    // Do not echo vendor error bodies: they can contain request data or credentials.
    const label = { 401: "密钥无效", 402: "余额不足", 403: "访问策略拒绝", 404: "无法取得可读正文", 429: "请求限流" }[response.status] ?? "请求失败";
    throw new ToolFailure(`DeepSeek HTTP ${response.status}：${label}`, response.status === 402 || response.status === 429);
  }
  if (!response.body) throw new ToolFailure("检索服务没有返回正文");
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ToolFailure("检索结果超过本片大小上限，未截断后伪装为完整原文");
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof ToolFailure) throw error;
    throw new ToolFailure("检索服务返回了损坏或不完整的 JSON");
  }
}

async function main() {
  if (process.env.ROOM_STRUCTURED_RESULTS_VERSION !== "1") throw new ToolFailure("此检索 profile 需要本次 Run 开启结构化结果");
  const base = baseUrl(), key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new ToolFailure("节点未配置 DEEPSEEK_API_KEY");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024) throw new ToolFailure("检索词须为 1–128 个 Unicode 字符");
    chunks.push(chunk);
  }
  const query = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  if (!query.trim() || Array.from(query).length > 128) throw new ToolFailure("检索词须为 1–128 个 Unicode 字符");
  display({ kind: "tool_step", stepId: "search", tool: "deepseek.search", status: "started", summary: "正在搜索公开网页" });
  let found;
  try {
    found = await request(base, key, "/v1/tools/search", { query, count: 1, need_content: false });
    if (!found || !Array.isArray(found.results) || found.results.length > 1) throw new ToolFailure("检索服务返回的结果结构不正确");
  } catch (error) {
    display({ kind: "tool_step", stepId: "search", tool: "deepseek.search", status: "failed", summary: "搜索未完成" });
    throw error;
  }
  display({ kind: "tool_step", stepId: "search", tool: "deepseek.search", status: "completed", summary: found.results.length ? "找到一条候选网页；摘要不视为原文" : "没有搜索结果" });
  if (found.results.length === 0) return "没有找到资料。本次没有可读原文或引用。";
  const url = pageUrl(found.results[0]?.url);
  display({ kind: "tool_step", stepId: "fetch", tool: "deepseek.fetch", status: "started", summary: "正在取回网页正文" });
  let page;
  try {
    page = await request(base, key, "/v1/tools/fetch", { url });
    if (!page || typeof page.title !== "string" || typeof page.content !== "string" || !page.content.trim()) throw new ToolFailure("网页没有可读的完整正文");
    if (Buffer.byteLength(page.content, "utf8") > MAX_CONTENT_BYTES) throw new ToolFailure("网页正文超过 512 KiB，未截断后伪装为完整原文");
  } catch (error) {
    display({ kind: "tool_step", stepId: "fetch", tool: "deepseek.fetch", status: "failed", summary: "未能取得可读原文" });
    display({ kind: "citation", citationId: "page-1", source: { source: { kind: "web", url }, version: null, contentHash: null, retrievedAt: new Date().toISOString(), status: "missing" } });
    throw error;
  }
  const contentHash = createHash("sha256").update(page.content, "utf8").digest("hex");
  display({ kind: "tool_step", stepId: "fetch", tool: "deepseek.fetch", status: "completed", summary: "已取回一页正文" });
  display({ kind: "citation", citationId: "page-1", ...(page.title ? { title: page.title.slice(0, 500) } : {}), source: { source: { kind: "web", url }, version: contentHash, contentHash, retrievedAt: new Date().toISOString(), status: "readable" } });
  return page.content;
}

let text, failure;
try { text = await main(); }
catch (error) { failure = error instanceof ToolFailure ? error : new ToolFailure("检索输入或服务响应无效"); }
if (process.env.ROOM_STRUCTURED_RESULTS_VERSION === "1") {
  display({ kind: "usage", scope: "run", inputTokens: unknown, outputTokens: unknown, toolCalls: { status: "measured", value: toolCalls }, cost: unknown });
}
if (failure) { out({ type: "error", message: failure.message, quota: failure.quota }); process.exitCode = 1; }
else out({ type: "done", text, finishReason: "stop" });
