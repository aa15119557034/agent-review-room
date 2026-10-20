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
 */

export type ParserOutput =
  | { kind: "text_delta"; text: string }
  | { kind: "unparsed"; line: string };

export type ParserVerdict =
  | { ok: true; finalText: string }
  | { ok: false; reason: "incomplete_output" | "internal"; message: string };

interface ResultLine {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
}

export class ClaudeStreamJsonParser {
  private buffer = "";
  private deltas = "";
  private result: ResultLine | null = null;

  /** 输入一段 stdout 文本（已经是完整的 UTF-8 字符），返回解析出的事件 */
  push(chunk: string): ParserOutput[] {
    this.buffer += chunk;
    const out: ParserOutput[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      this.handleLine(line, out);
    }
    return out;
  }

  /** 进程结束时调用：处理最后一行（可能没有换行），给出结论 */
  finish(): { trailing: ParserOutput[]; verdict: ParserVerdict } {
    const trailing: ParserOutput[] = [];
    if (this.buffer.trim()) this.handleLine(this.buffer.replace(/\r$/, ""), trailing);
    this.buffer = "";

    const r = this.result;
    if (!r) {
      return {
        trailing,
        verdict: { ok: false, reason: "incomplete_output", message: "Reviewer 的输出在结束标记之前中断" },
      };
    }
    if (r.is_error || (r.subtype && r.subtype !== "success")) {
      const detail = typeof r.result === "string" && r.result ? r.result.slice(0, 500) : r.subtype ?? "error";
      return { trailing, verdict: { ok: false, reason: "internal", message: `Claude 返回错误：${detail}` } };
    }
    // result 字段是权威的完整回复；万一缺失，用增量拼出来的文字
    const finalText = typeof r.result === "string" ? r.result : this.deltas;
    return { trailing, verdict: { ok: true, finalText } };
  }

  private handleLine(line: string, out: ParserOutput[]) {
    if (!line.trim()) return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      // 不是 JSON（比如 CLI 打印的警告）：原样转发，便于排查，不当作回复
      out.push({ kind: "unparsed", line });
      return;
    }
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;

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

    if (o["type"] === "result") {
      this.result = o as unknown as ResultLine;
    }
  }
}
