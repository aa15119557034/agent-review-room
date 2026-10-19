import { createHash, randomBytes } from "node:crypto";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentInput,
  RunOptions,
  Session,
  SessionConfig,
} from "@room/core";
import type { AgentEvent } from "@room/schemas";

/**
 * Reviewer API Adapter（D-05）。
 *
 * 硬性要求：
 * - **只发送 input.content 原文**（AC-7）。不在这一层重新拼 Prompt、不裁剪、不改写。
 * - 发送前重算 sha256 并与 input.contentHash 比对，不一致直接报错、不发请求。
 * - API key 只从调用方传入（由 main 进程读取），本模块不读环境变量、不写日志。
 * - 恰好产出一个终止事件；任何异常都转成 error，迭代器不抛（AgentAdapter 契约）。
 */

/** 与契约一致：sha256(UTF-8(content))，不做任何规范化。 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const TERMINAL_TYPES = new Set(["completed", "error", "cancelled", "timed_out"]);

/** Omit 作用在联合类型上不会分发，这里显式分发，保留每个成员自己的字段。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EmittedEvent = DistributiveOmit<AgentEvent, "eventId" | "runId" | "seq" | "ts">;

export interface ReviewerClientOptions {
  readonly apiKey: string;
  readonly model: string;
  /** 默认 https://api.deepseek.com */
  readonly baseUrl?: string;
  /** 注入 fetch 便于测试 */
  readonly fetchImpl?: typeof fetch;
  readonly adapterId?: string;
}

interface ChatChunk {
  choices?: { delta?: { content?: string } }[];
}

/** 把 SSE 文本块解析成增量文本；返回剩余未闭合的缓冲。 */
function parseSse(buffer: string): { texts: string[]; done: boolean; rest: string } {
  const texts: string[] = [];
  let done = false;
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";

  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        done = true;
        continue;
      }
      try {
        const chunk = JSON.parse(payload) as ChatChunk;
        const text = chunk.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text.length > 0) texts.push(text);
      } catch {
        // 单条坏数据不应让整个 run 失败：跳过并继续读流
      }
    }
  }

  return { texts, done, rest };
}

export class ReviewerAdapter implements AgentAdapter {
  readonly id: string;
  readonly kind = "api" as const;

  readonly #options: ReviewerClientOptions;
  readonly #fetch: typeof fetch;

  constructor(options: ReviewerClientOptions) {
    if (options.apiKey.trim() === "") throw new Error("reviewer api key is required");
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.id = options.adapterId ?? "reviewer-api";
  }

  async initialize(): Promise<AgentCapabilities> {
    return { streaming: true, permissionRequests: false, readOnly: true };
  }

  async startSession(_config: SessionConfig): Promise<Session> {
    return { sessionId: `sess_${randomBytes(8).toString("hex")}`, adapterId: this.id };
  }

  async closeSession(_sessionId: string): Promise<void> {
    // 无状态：每个 run 一个 HTTP 请求，没有需要清理的会话
  }

  async *run(
    _sessionId: string,
    runId: string,
    input: AgentInput,
    opts: RunOptions,
  ): AsyncIterable<AgentEvent> {
    let seq = 0;
    const emit = (event: EmittedEvent): AgentEvent =>
      ({
        ...event,
        eventId: `${runId}-${seq}`,
        runId,
        seq: seq++,
        ts: new Date().toISOString(),
      }) as AgentEvent;

    // ---- 发送前校验：内容和 hash 必须对得上，否则一个字都不发 ----
    const actualHash = sha256Hex(input.content);
    if (actualHash !== input.contentHash) {
      yield emit({
        type: "error",
        reason: "hash_mismatch",
        message: `snapshot hash mismatch: expected ${input.contentHash}, got ${actualHash}`,
      });
      return;
    }

    if (opts.signal.aborted) {
      yield emit({ type: "cancelled", reason: "aborted before start" });
      return;
    }

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort();
    opts.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.totalTimeoutMs);

    let text = "";
    let terminalSent = false;

    try {
      const response = await this.#fetch(`${this.#options.baseUrl ?? "https://api.deepseek.com"}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.#options.model,
          stream: true,
          // 只发 snapshot.content 原文，不附加任何东西（AC-7）
          messages: [{ role: "user", content: input.content }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        yield emit({
          type: "error",
          reason: "internal",
          message: `reviewer api returned HTTP ${response.status}`,
        });
        terminalSent = true;
        return;
      }

      if (response.body === null) {
        yield emit({ type: "error", reason: "internal", message: "reviewer api returned an empty body" });
        terminalSent = true;
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const piece of parsed.texts) {
          text += piece;
          yield emit({ type: "message_delta", text: piece });
        }
      }

      buffer += decoder.decode();
      const tail = parseSse(`${buffer}\n\n`);
      for (const piece of tail.texts) {
        text += piece;
        yield emit({ type: "message_delta", text: piece });
      }

      yield emit({ type: "message_complete", text });
      terminalSent = true;
      yield emit({ type: "completed" });
    } catch (error) {
      if (terminalSent) return;

      if (opts.signal.aborted) {
        yield emit({ type: "cancelled", reason: "aborted by caller" });
      } else if (timedOut) {
        yield emit({ type: "timed_out", kind: "total" });
      } else {
        yield emit({
          type: "error",
          reason: "internal",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
    }
  }
}

export function createReviewerAdapter(options: ReviewerClientOptions): AgentAdapter {
  return new ReviewerAdapter(options);
}

export type { AgentAdapter, AgentCapabilities, AgentInput, RunOptions, Session, SessionConfig };
export { TERMINAL_TYPES };
