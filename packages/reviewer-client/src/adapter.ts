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
 * - 只发送 input.content 原文（AC-7）：不重新拼 Prompt、不裁剪、不改写。
 * - 发送前重算 sha256 并与 input.contentHash 比对，不一致直接报错、不发请求。
 * - API key 只从调用方传入（由 main 进程读取），本模块不读环境变量、不写日志。
 * - 恰好产出一个终止事件；任何异常都转成 error，迭代器不抛（AgentAdapter 契约）。
 * - 消费方 break（iterator.return()）等同 abort：请求必须被中止并取消流（不变量第 4 条）。
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
  /** 默认 https://api.deepseek.com（是否换成别的 Reviewer 待产品确认） */
  readonly baseUrl?: string;
  /** 注入 fetch 便于测试 */
  readonly fetchImpl?: typeof fetch;
  readonly adapterId?: string;
}

interface ChatChunk {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
}

interface ParsedSse {
  texts: string[];
  done: boolean;
  finishReason: string | null;
  rest: string;
}

/**
 * 把 SSE 文本块解析成增量文本。
 * - 先把 CRLF 规范化为 LF：某些代理会把 \n\n 变成 \r\n\r\n，不处理会吞掉全部内容
 * - 记录是否收到 [DONE] 与 finish_reason，供上层判断「流是不是被提前截断」
 */
function parseSse(buffer: string): ParsedSse {
  const texts: string[] = [];
  let done = false;
  let finishReason: string | null = null;
  const normalized = buffer.split("\r\n").join("\n");
  const parts = normalized.split("\n\n");
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
        const choice = chunk.choices?.[0];
        const text = choice?.delta?.content;
        if (typeof text === "string" && text.length > 0) texts.push(text);
        if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      } catch {
        // 单条坏数据不应让整个 run 失败：跳过并继续读流
      }
    }
  }

  return { texts, done, finishReason, rest };
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
    return { sessionId: "sess_" + randomBytes(8).toString("hex"), adapterId: this.id };
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
      ({ ...event, eventId: runId + "-" + seq, runId, seq: seq++, ts: new Date().toISOString() }) as AgentEvent;

    // ---- 发送前校验：内容和 hash 必须对得上，否则一个字都不发 ----
    const actualHash = sha256Hex(input.content);
    if (actualHash !== input.contentHash) {
      yield emit({
        type: "error",
        reason: "hash_mismatch",
        message: "snapshot hash mismatch: expected " + input.contentHash + ", got " + actualHash,
      });
      return;
    }

    if (opts.signal.aborted) {
      yield emit({ type: "cancelled", reason: "aborted before start" });
      return;
    }

    const controller = new AbortController();
    let totalTimedOut = false;
    let idleTimedOut = false;
    let terminalSent = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => controller.abort();
    opts.signal.addEventListener("abort", onAbort, { once: true });

    // abort 时让挂起的 read() 立刻退出，否则 idle/total 超时要等下一块数据才生效
    let rejectAborted: (error: Error) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    // 只用于 Promise.race。连接阶段就被取消时它还没被 race 接住，
    // 不挂空处理会变成 unhandled rejection —— 在 Electron main 里就是整个应用退出。
    aborted.catch(() => undefined);
    controller.signal.addEventListener("abort", () => rejectAborted(new Error("request aborted")), { once: true });

    const totalTimer = setTimeout(() => {
      totalTimedOut = true;
      controller.abort();
    }, opts.totalTimeoutMs);

    const resetIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        controller.abort();
      }, opts.idleTimeoutMs);
    };

    try {
      const response = await this.#fetch(
        (this.#options.baseUrl ?? "https://api.deepseek.com") + "/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + this.#options.apiKey,
          },
          body: JSON.stringify({
            model: this.#options.model,
            stream: true,
            // 只发 snapshot.content 原文，不附加任何东西（AC-7）
            messages: [{ role: "user", content: input.content }],
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        await response.body?.cancel();
        yield emit({ type: "error", reason: "internal", message: "reviewer api returned HTTP " + response.status });
        terminalSent = true;
        return;
      }

      if (response.body === null) {
        yield emit({ type: "error", reason: "internal", message: "reviewer api returned an empty body" });
        terminalSent = true;
        return;
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawDone = false;
      let finishReason: string | null = null;
      let text = "";

      resetIdle();

      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        resetIdle();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        if (parsed.done) sawDone = true;
        if (parsed.finishReason !== null) finishReason = parsed.finishReason;
        for (const piece of parsed.texts) {
          text += piece;
          yield emit({ type: "message_delta", text: piece });
        }
      }

      buffer += decoder.decode();
      const tail = parseSse(buffer + "\n\n");
      if (tail.done) sawDone = true;
      if (tail.finishReason !== null) finishReason = tail.finishReason;
      for (const piece of tail.texts) {
        text += piece;
        yield emit({ type: "message_delta", text: piece });
      }

      // 没有 [DONE] 也没有 finish_reason：流被中途截断，绝不能当成正常完成
      if (!sawDone && finishReason === null) {
        yield emit({
          type: "error",
          reason: "incomplete_output",
          message: "stream ended unexpectedly (no [DONE] and no finish_reason); result discarded",
        });
        terminalSent = true;
        return;
      }

      yield emit({ type: "message_complete", text });
      terminalSent = true;

      if (finishReason === "length") {
        // 被 max tokens 截断：内容不完整，不能标成 completed
        yield emit({
          type: "error",
          reason: "output_limit_exceeded",
          message: "reviewer output was truncated at max tokens (finish_reason=length)",
        });
      } else {
        yield emit({ type: "completed" });
      }
    } catch (error) {
      if (!terminalSent) {
        if (opts.signal.aborted) {
          yield emit({ type: "cancelled", reason: "aborted by caller" });
        } else if (idleTimedOut) {
          yield emit({ type: "timed_out", kind: "idle" });
        } else if (totalTimedOut) {
          yield emit({ type: "timed_out", kind: "total" });
        } else {
          yield emit({
            type: "error",
            reason: "internal",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        terminalSent = true;
      }
    } finally {
      clearTimeout(totalTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      opts.signal.removeEventListener("abort", onAbort);

      // 消费方 break / 异常退出时没有终止事件：必须中止请求并释放流，
      // 否则 Reviewer 会继续生成、继续计费（AgentAdapter 不变量第 4 条）
      if (!terminalSent) {
        try {
          controller.abort();
        } catch {
          // 已经 abort 过
        }
        try {
          await reader?.cancel();
        } catch {
          // 流可能已经关闭
        }
      }
    }
  }
}

export function createReviewerAdapter(options: ReviewerClientOptions): AgentAdapter {
  return new ReviewerAdapter(options);
}

export type { AgentAdapter, AgentCapabilities, AgentInput, RunOptions, Session, SessionConfig };
export { TERMINAL_TYPES };
