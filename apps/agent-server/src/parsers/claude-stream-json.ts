/**
 * `claude -p --output-format stream-json --verbose --include-partial-messages` 的输出解析器。
 *
 * 每行一个 JSON 对象。我们只关心：
 * - {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}}
 *     → 增量文字
 * - {"type":"result","subtype":"success","is_error":false,"result":"完整回复", …}
 *     → 最后一行：完整回复和成功 / 失败
 * 其他类型（system/init、assistant、user 工具结果……）忽略。
 *
 * 关键规则：**没看到 result 行就不算完成**。进程退出码是 0 也一样——流可能被截断。
 * 错误结果如果是额度用尽 / 限流（例如 "Claude AI usage limit reached"，或 api_error_status 429），
 * 结论是 quota_exhausted（C-25），讨论里显示为「缺席（额度）」。
 */
import { errorVerdict, JsonLinesParser, type ParserOutput, type ParserVerdict } from "./common";

export type { ParserOutput, ParserVerdict } from "./common";

interface ResultLine {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  api_error_status?: number | null;
}

export class ClaudeStreamJsonParser extends JsonLinesParser {
  private deltas = "";
  private result: ResultLine | null = null;

  protected handleObject(o: Record<string, unknown>, out: ParserOutput[]): void {
    if (o["type"] === "stream_event") {
      const ev = o["event"] as Record<string, unknown> | undefined;
      const delta = ev?.["delta"] as Record<string, unknown> | undefined;
      if (ev?.["type"] === "content_block_delta" && delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
        // 只统计主对话的文字；子 agent 的消息带 parent_tool_use_id，不算 Reviewer 的回复
        if (o["parent_tool_use_id"] == null) {
          this.deltas += delta["text"];
          out.push({ kind: "text_delta", text: delta["text"] as string });
        }
      }
      return;
    }
    if (o["type"] === "rate_limit_event") {
      out.push({ kind: "rate_limit", info: o["rate_limit_info"] });
      return;
    }
    if (o["type"] === "result") this.result = o as unknown as ResultLine;
  }

  protected verdict(): ParserVerdict {
    const r = this.result;
    if (!r) return { ok: false, reason: "incomplete_output", message: "Reviewer 的输出在结束标记之前中断" };
    if (r.is_error || (r.subtype && r.subtype !== "success")) {
      const detail = typeof r.result === "string" && r.result ? r.result.slice(0, 500) : r.subtype ?? "error";
      const v = errorVerdict(r.api_error_status === 429 ? `429 ${detail}` : detail);
      return v.ok ? v : { ...v, message: `Claude 返回错误：${v.message}` };
    }
    // result 字段是权威的完整回复；万一缺失，用增量拼出来的文字
    return { ok: true, finalText: typeof r.result === "string" ? r.result : this.deltas };
  }
}
