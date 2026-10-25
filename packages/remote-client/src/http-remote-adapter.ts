import { createHash, randomBytes } from "node:crypto";
import type {
  AgentCapabilities,
  AgentInput,
  ReconcileReport,
  RemoteAgentAdapter,
  RemoteNodeConfig,
  RunOptions,
  Session,
  SessionConfig,
} from "@room/core";
import {
  NodeHealth,
  REMOTE_PROTOCOL_VERSION,
  RemoteEvent,
  RemoteRunSummary,
  RunModel,
  isTerminalEvent,
  type AgentEvent,
  type FailureReason,
  type NodeTestResult,
  type RemoteTerminal,
  type RunId,
} from "@room/schemas";
import { z } from "zod";

/**
 * RemoteAgentAdapter 的 HTTP 实现（S-03，原 D-08）。
 * 行为约定见 packages/core/src/adapter/remote-agent-adapter.ts 的注释，这里逐条实现：
 *
 * - 启动：POST /v1/runs，网络错误用同一个 runId 重试（节点按 runId 幂等）
 * - 事件流：GET /v1/runs/:id/events?after=<lastSeq>，断线后带 lastSeq 重连，节点补发，不丢不重
 * - 心跳：超过 heartbeatTimeoutMs 收不到任何字节 → 判定断线（等待人工时也有心跳，不会误判）
 * - 宽限期：断线超过 reconnectGraceMs → error(connection_lost)。因为 leaseMs < reconnectGraceMs，
 *   此时节点一定已经自己停止了评审
 * - 取消：signal abort → POST cancel，继续读流等节点的 cancelled；连接断了或等太久 → cancelled(unconfirmed)
 * - 消费方中途 break / 应用退出：finally 里通知节点取消，不让它在后台继续消耗额度
 * - 恰好一个终止事件；任何异常都转成 error，迭代器不 throw
 */

export interface HttpRemoteAgentAdapterOptions extends RemoteNodeConfig {
  /** 由 main 进程从系统凭据库读出后传入；本模块不读环境变量、不写日志 */
  token: string;
  /** C-40：这一批盖章时定下的模型/强度；不传 = profile 自带模型 */
  model?: RunModel;
  fetchImpl?: typeof fetch;
  adapterId?: string;
  /** 断线后每次重连前等待多久，默认 500ms */
  reconnectDelayMs?: number;
  /** 请求取消后，最多等节点确认多久，默认 15s */
  cancelConfirmMs?: number;
  /** 启动请求遇到网络错误时的重试次数，默认 3 */
  startAttempts?: number;
  log?: (message: string) => void;
}

type Emitted = DistributiveOmit<AgentEvent, "eventId" | "runId" | "seq" | "ts">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 连接节点失败时的分类，设置页的"测试连接"直接用它 */
export class NodeRequestError extends Error {
  constructor(
    readonly code: "unreachable" | "timeout" | "unauthorized" | "protocol_mismatch" | "http",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "NodeRequestError";
  }
}

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const ErrorBody = z.object({ error: z.string(), message: z.string() }).partial();

export class HttpRemoteAgentAdapter implements RemoteAgentAdapter {
  readonly id: string;
  readonly kind = "remote" as const;
  readonly node: Readonly<RemoteNodeConfig>;

  readonly #token: string;
  readonly #model: RunModel | undefined;
  readonly #fetch: typeof fetch;
  readonly #reconnectDelayMs: number;
  readonly #cancelConfirmMs: number;
  readonly #startAttempts: number;
  readonly #log: (m: string) => void;

  constructor(options: HttpRemoteAgentAdapterOptions) {
    const { token, model, fetchImpl, adapterId, reconnectDelayMs, cancelConfirmMs, startAttempts, log, ...node } = options;
    if (token.length < 32) throw new Error("remote node token must be at least 32 characters");
    this.node = Object.freeze({ ...node, baseUrl: node.baseUrl.replace(/\/+$/, "") });
    this.#token = token;
    this.#model = model;
    this.#fetch = fetchImpl ?? globalThis.fetch;
    this.id = adapterId ?? `remote:${node.nodeId}:${node.profileId}`;
    this.#reconnectDelayMs = reconnectDelayMs ?? 500;
    this.#cancelConfirmMs = cancelConfirmMs ?? 15_000;
    this.#startAttempts = startAttempts ?? 3;
    this.#log = log ?? (() => {});
  }

  // ------------------------------------------------------------ 基础请求

  #headers(json = false): Record<string, string> {
    return {
      authorization: `Bearer ${this.#token}`,
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  async #request(path: string, init: RequestInit = {}, timeoutMs = this.node.requestTimeoutMs): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      return await this.#fetch(`${this.node.baseUrl}${path}`, { ...init, signal });
    } catch (err) {
      if (timeout.aborted) throw new NodeRequestError("timeout", `连接执行节点超时（${timeoutMs}ms）`);
      throw new NodeRequestError("unreachable", `无法连接执行节点 ${this.node.baseUrl}：${describe(err)}`);
    }
  }

  async #json<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
    if (res.status === 401) throw new NodeRequestError("unauthorized", "Token 不正确", 401);
    if (!res.ok) throw new NodeRequestError("http", `执行节点返回 HTTP ${res.status}`, res.status);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new NodeRequestError("protocol_mismatch", "执行节点的响应格式不符合协议（版本不一致？）");
    return parsed.data;
  }

  // ------------------------------------------------------------ RemoteAgentAdapter

  async health(signal?: AbortSignal): Promise<NodeHealth> {
    const res = await this.#request("/v1/health", { headers: this.#headers(), ...(signal ? { signal } : {}) });
    const h = await this.#json(res, NodeHealth);
    if (h.protocol !== REMOTE_PROTOCOL_VERSION) {
      throw new NodeRequestError("protocol_mismatch", `执行节点协议版本 ${h.protocol}，本端是 ${REMOTE_PROTOCOL_VERSION}`);
    }
    return h;
  }

  async listRemoteRuns(signal?: AbortSignal): Promise<RemoteRunSummary[]> {
    const res = await this.#request("/v1/runs", { headers: this.#headers(), ...(signal ? { signal } : {}) });
    return this.#json(res, z.array(RemoteRunSummary));
  }

  async reconcile(localActiveRunIds: readonly RunId[], signal?: AbortSignal): Promise<ReconcileReport> {
    const remote = await this.listRemoteRuns(signal);
    const local = new Set<string>(localActiveRunIds);
    const remoteIds = new Set(remote.map((r) => r.runId));
    return {
      orphansOnNode: remote.filter((r) => r.state === "running" && !local.has(r.runId)).map((r) => r.runId),
      missingOnNode: localActiveRunIds.filter((id) => !remoteIds.has(id)),
    };
  }

  async initialize(): Promise<AgentCapabilities> {
    const h = await this.health();
    if (!h.profiles.includes(this.node.profileId)) {
      throw new Error(`执行节点上没有评审方式 "${this.node.profileId}"（可用：${h.profiles.join("、")}）`);
    }
    if (h.leaseMs >= this.node.reconnectGraceMs) {
      throw new Error(
        `配置不安全：节点租约 ${h.leaseMs}ms 必须小于本端重连宽限期 ${this.node.reconnectGraceMs}ms，否则断线时可能出现"本地已判失败、节点还在跑"`,
      );
    }
    if (this.node.heartbeatTimeoutMs < h.heartbeatMs * 2) {
      this.#log(`[remote] heartbeatTimeoutMs=${this.node.heartbeatTimeoutMs} 小于节点心跳间隔的两倍，容易误判断线`);
    }
    return { streaming: true, permissionRequests: false, readOnly: true };
  }

  async startSession(_config: SessionConfig): Promise<Session> {
    return { sessionId: `sess_${randomBytes(8).toString("hex")}`, adapterId: this.id };
  }

  async closeSession(_sessionId: string): Promise<void> {}

  /** 尽力通知节点取消；失败只记日志（节点的租约机制兜底） */
  async #sendCancel(runId: string, reason: string): Promise<void> {
    try {
      const res = await this.#request(`/v1/runs/${runId}/cancel`, {
        method: "POST",
        headers: this.#headers(true),
        body: JSON.stringify({ reason }),
      });
      await res.body?.cancel();
    } catch (err) {
      this.#log(`[remote] cancel ${runId} failed: ${describe(err)}`);
    }
  }

  async *run(_sessionId: string, runId: RunId, input: AgentInput, opts: RunOptions): AsyncIterable<AgentEvent> {
    let seq = 0;
    let terminated = false;
    const emit = (e: Emitted): AgentEvent => {
      const ev = { ...e, eventId: `${runId}-${seq}`, runId, seq: seq++, ts: new Date().toISOString() } as AgentEvent;
      if (isTerminalEvent(ev)) terminated = true;
      return ev;
    };

    // 发送前本地再校验一次：内容和 hash 对不上，一个字都不发
    if (sha256Hex(input.content) !== input.contentHash) {
      yield emit({ type: "error", reason: "hash_mismatch", message: "发送前校验失败：prompt 内容与指纹不一致" });
      return;
    }
    if (opts.signal.aborted) {
      yield emit({ type: "cancelled", reason: "开始前已取消" });
      return;
    }

    let cancelRequested = false;
    let cancelAt = 0;
    let started = false;
    let conn: AbortController | null = null;
    const wake = new EventTarget();
    const onAbort = () => {
      cancelRequested = true;
      cancelAt = Date.now();
      if (started) void this.#sendCancel(runId, "用户取消");
      wake.dispatchEvent(new Event("wake"));
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    try {
      // ---------------------------------------------------- 1. 启动
      const start = await this.#start(runId, input, opts);
      if (!start.ok) {
        yield emit(start.event);
        return;
      }
      started = true;
      if (cancelRequested) void this.#sendCancel(runId, "用户取消");

      // ---------------------------------------------------- 2. 读事件流（含断线重连）
      let lastSeq = -1;
      let substate: "active" | "disconnected" | null = null;
      let disconnectedSince: number | null = null;
      const hardDeadline = Date.now() + opts.totalTimeoutMs + this.node.reconnectGraceMs + 10_000;

      for (;;) {
        let outcome: "terminal" | "dropped" | "gone" | "unauthorized" | "cancel_timeout" | "deadline" = "dropped";
        conn = new AbortController();
        try {
          const res = await this.#fetch(`${this.node.baseUrl}/v1/runs/${runId}/events?after=${lastSeq}`, {
            headers: this.#headers(),
            signal: conn.signal,
          });
          if (res.status === 404) outcome = "gone";
          else if (res.status === 401) outcome = "unauthorized";
          else if (res.ok && res.body) {
            if (substate !== "active") {
              substate = "active";
              disconnectedSince = null;
              yield emit({ type: "status", substate: "active" });
            }
            for await (const line of readLines(res.body, conn, this.node.heartbeatTimeoutMs)) {
              if (cancelRequested && Date.now() - cancelAt > this.#cancelConfirmMs) {
                outcome = "cancel_timeout";
                break;
              }
              if (Date.now() > hardDeadline) {
                outcome = "deadline";
                break;
              }
              const parsed = RemoteEvent.safeParse(safeJson(line));
              if (!parsed.success) {
                this.#log(`[remote] ignoring malformed event line`);
                continue;
              }
              const ev = parsed.data;
              if (ev.type === "heartbeat") continue;
              if (ev.seq <= lastSeq) continue; // 重连补发时可能重复
              lastSeq = ev.seq;
              const mapped = mapRemoteEvent(ev);
              if (mapped) yield emit(mapped);
              if (ev.type === "terminal") {
                outcome = "terminal";
                break;
              }
            }
          } else {
            await res.body?.cancel();
          }
        } catch {
          outcome = "dropped";
        } finally {
          conn.abort();
          conn = null;
        }

        switch (outcome) {
          case "terminal":
            return;
          case "gone":
            yield emit({ type: "error", reason: "remote_lost", message: "执行节点已经不认识这次评审（可能重启过）" });
            return;
          case "unauthorized":
            yield emit({ type: "error", reason: "remote_rejected", message: "执行节点拒绝了 Token" });
            return;
          case "cancel_timeout":
            yield emit({ type: "cancelled", reason: "已请求取消，节点未在规定时间内确认（unconfirmed）" });
            return;
          case "deadline":
            void this.#sendCancel(runId, "超过总时长");
            yield emit({ type: "timed_out", kind: "total" });
            return;
        }

        // dropped：断线
        if (cancelRequested) {
          // 取消已经发出，连接又断了：不再等，节点的租约会让它停下
          yield emit({ type: "cancelled", reason: "已请求取消，连接中断无法确认（unconfirmed）" });
          return;
        }
        if (disconnectedSince === null) {
          disconnectedSince = Date.now();
          substate = "disconnected";
          yield emit({ type: "status", substate: "disconnected" });
        }
        if (Date.now() - disconnectedSince >= this.node.reconnectGraceMs) {
          yield emit({ type: "error", reason: "connection_lost", message: `与执行节点断开超过 ${this.node.reconnectGraceMs}ms` });
          return;
        }
        await sleepUnless(this.#reconnectDelayMs, wake);
      }
    } catch (err) {
      if (!terminated) yield emit({ type: "error", reason: "internal", message: describe(err) });
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      conn?.abort();
      // 消费方提前停止（break / 应用退出）：让节点也停下，不在后台继续消耗额度
      if (!terminated && started && !cancelRequested) void this.#sendCancel(runId, "主控端停止读取");
    }
  }

  async #start(
    runId: RunId,
    input: AgentInput,
    opts: RunOptions,
  ): Promise<{ ok: true } | { ok: false; event: Emitted }> {
    const body = JSON.stringify({
      protocol: REMOTE_PROTOCOL_VERSION,
      runId,
      profileId: this.node.profileId,
      snapshot: {
        id: input.snapshotId,
        content: input.content,
        contentHash: input.contentHash,
        ...(input.commitSha ? { commitSha: input.commitSha } : {}),
      },
      limits: { idleTimeoutMs: opts.idleTimeoutMs, totalTimeoutMs: opts.totalTimeoutMs },
      // C-40：null = profile 自带模型，字段整个省略（不是传 null）
      ...(this.#model === undefined ? {} : { model: this.#model }),
    });

    let lastError = "";
    for (let attempt = 1; attempt <= this.#startAttempts; attempt++) {
      let res: Response;
      try {
        res = await this.#request("/v1/runs", { method: "POST", headers: this.#headers(true), body });
      } catch (err) {
        lastError = describe(err);
        if (opts.signal.aborted) return { ok: false, event: { type: "cancelled", reason: "开始前已取消" } };
        await sleep(this.#reconnectDelayMs * attempt);
        continue; // 同一个 runId 重试是安全的：节点按 runId 幂等
      }
      if (res.status === 200 || res.status === 202) {
        await res.body?.cancel();
        return { ok: true };
      }
      if (res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        await res.body?.cancel();
        await sleep(this.#reconnectDelayMs * attempt);
        continue;
      }
      const err = ErrorBody.safeParse(await res.json().catch(() => ({})));
      const code = err.success ? err.data.error : undefined;
      const msg = err.success && err.data.message ? err.data.message : `HTTP ${res.status}`;
      const reason: FailureReason =
        code === "hash_mismatch" ? "hash_mismatch" : code === "commit_mismatch" ? "commit_mismatch" : "remote_rejected";
      const human =
        res.status === 401
          ? "执行节点拒绝了 Token，请在设置里检查"
          : code === "node_busy"
            ? "执行节点正忙（已达到并发上限），请稍后再试"
            : code === "unknown_profile"
              ? `执行节点上没有评审方式 "${this.node.profileId}"`
              : msg;
      return { ok: false, event: { type: "error", reason, message: human } };
    }
    return { ok: false, event: { type: "error", reason: "connection_lost", message: `无法连接执行节点：${lastError}` } };
  }
}

// ------------------------------------------------------------ 设置页"测试连接"

/** 用填写的地址和 Token 测试节点。main 进程的 settings.testReviewerNode 直接调用 */
export async function testReviewerNode(params: {
  baseUrl: string;
  token: string | null;
  profileId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<NodeTestResult> {
  if (!params.token) return { reachable: false, error: "no_token", message: "还没有填写 Token" };
  const adapter = new HttpRemoteAgentAdapter({
    nodeId: "test",
    baseUrl: params.baseUrl,
    profileId: params.profileId,
    token: params.token,
    heartbeatTimeoutMs: 15_000,
    reconnectGraceMs: 30_000,
    requestTimeoutMs: params.timeoutMs ?? 5_000,
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });
  const t0 = Date.now();
  try {
    const health = await adapter.health();
    return {
      reachable: true,
      health,
      profileAvailable: health.profiles.includes(params.profileId),
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    if (err instanceof NodeRequestError) {
      const error = err.code === "http" ? "unreachable" : err.code;
      return { reachable: false, error, message: err.message };
    }
    return { reachable: false, error: "unreachable", message: describe(err) };
  }
}

// ------------------------------------------------------------ 工具

export function mapRemoteEvent(ev: Exclude<RemoteEvent, { type: "heartbeat" }>): Emitted | null {
  switch (ev.type) {
    case "started":
    case "permission_request": // Phase 0 的 Reviewer 不使用工具；权限中继留给 Phase 1
      return null;
    case "output":
      return { type: "output", stream: ev.stream, data: ev.data };
    case "text_delta":
      return { type: "message_delta", text: ev.text };
    case "message_complete":
      return { type: "message_complete", text: ev.text };
    case "prompt_final": // C-34：聊天 Run 的最终 hash 和记忆清单，原样转发
      return { type: "prompt_final", finalPromptHash: ev.finalPromptHash, memory: ev.memory };
    case "terminal":
      return mapTerminal(ev.result);
  }
}

function mapTerminal(r: RemoteTerminal): Emitted {
  switch (r.outcome) {
    case "completed":
      return { type: "completed" };
    case "cancelled":
      return { type: "cancelled", ...(r.reason ? { reason: r.reason } : {}) };
    case "timed_out":
      return { type: "timed_out", kind: r.kind };
    case "error": {
      const reason: FailureReason = r.reason === "node_shutdown" ? "remote_lost" : r.reason;
      return { type: "error", reason, exitCode: r.exitCode, ...(r.message ? { message: r.message } : {}) };
    }
  }
}

/** 按行读 NDJSON；超过 idleMs 收不到任何字节就中止连接（心跳超时） */
async function* readLines(body: ReadableStream<Uint8Array>, conn: AbortController, idleMs: number): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timer = setTimeout(() => conn.abort(), idleMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      clearTimeout(timer);
      if (done) break;
      timer = setTimeout(() => conn.abort(), idleMs);
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) yield line;
      }
    }
    const rest = (buffer + decoder.decode()).trim();
    if (rest) yield rest;
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 等待 ms 毫秒，或者被 wake 事件提前唤醒（例如用户取消） */
function sleepUnless(ms: number, wake: EventTarget): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      wake.removeEventListener("wake", done);
      resolve();
    }
    wake.addEventListener("wake", done, { once: true });
  });
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return cause ? `${err.message}（${cause}）` : err.message;
  }
  return String(err);
}
