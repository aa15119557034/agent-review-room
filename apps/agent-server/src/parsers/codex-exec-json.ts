/**
 * `codex exec --json` 的输出解析器（JSON Lines，每行一个事件）。
 *
 * 我们关心的事件（官方文档：thread.started / turn.started / turn.completed / turn.failed / item.* / error）：
 * - {"type":"item.completed","item":{"type":"agent_message","text":"…"}}  → Agent 说的一段话
 * - {"type":"turn.completed","usage":{…}}                                 → 这一轮正常结束
 * - {"type":"turn.failed","error":{"message":"…"}}                        → 这一轮失败
 * - {"type":"error","message":"…"}                                         → 出错。可能只是重连提示，
 *                                                                            所以单独出现不算失败，要看最后有没有 turn.completed
 * 其他（reasoning、command_execution、item.started / item.updated……）忽略。
 *
 * 规则：
 * - 必须看到 turn.completed 才算完成；最终回复取**最后一条** agent_message（和 `codex exec -o` 一致）
 * - 每条 agent_message 都作为增量文字推给界面，多条之间空一行
 * - turn.failed / 没有 turn.completed 时的 error，如果是额度或限流 → quota_exhausted
 */
import { errorVerdict, JsonLinesParser, type ParserOutput, type ParserVerdict } from "./common";

export class CodexExecJsonParser extends JsonLinesParser {
  private messages: string[] = [];
  private completed = false;
  private failed: string | null = null;
  private lastError: string | null = null;

  protected handleObject(o: Record<string, unknown>, out: ParserOutput[]): void {
    switch (o["type"]) {
      case "item.completed": {
        const item = o["item"] as Record<string, unknown> | undefined;
        if (item?.["type"] === "agent_message" && typeof item["text"] === "string") {
          const text = item["text"] as string;
          out.push({ kind: "text_delta", text: (this.messages.length ? "\n\n" : "") + text });
          this.messages.push(text);
        }
        return;
      }
      case "turn.completed":
        this.completed = true;
        return;
      case "turn.failed":
        this.failed = messageOf(o["error"]) ?? "turn failed";
        return;
      case "error":
        this.lastError = messageOf(o) ?? "error";
        return;
    }
  }

  protected verdict(): ParserVerdict {
    if (this.failed !== null) return withPrefix(errorVerdict(this.failed));
    if (!this.completed) {
      if (this.lastError !== null) return withPrefix(errorVerdict(this.lastError));
      return { ok: false, reason: "incomplete_output", message: "Codex 的输出在 turn.completed 之前中断" };
    }
    const last = this.messages[this.messages.length - 1];
    if (last === undefined) return { ok: false, reason: "incomplete_output", message: "Codex 这一轮没有任何回复" };
    return { ok: true, finalText: last };
  }
}

function messageOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as Record<string, unknown>)["message"] === "string") {
    return (v as Record<string, unknown>)["message"] as string;
  }
  return null;
}

function withPrefix(v: ParserVerdict): ParserVerdict {
  return v.ok ? v : { ...v, message: `Codex 返回错误：${v.message}` };
}
