/**
 * 各 CLI 输出解析器的公共部分。
 *
 * 所有解析器都遵守同一条规则：**没看到明确的"成功结束"标记就不算完成**，
 * 进程退出码是 0 也一样（流可能被截断）。
 */

import type { ResultDisplay } from "@room/schemas";

export type ParserOutput =
  | { kind: "result_display"; result: ResultDisplay }
  | { kind: "text_delta"; text: string }
  | { kind: "unparsed"; line: string }
  /** S-21：CLI 顺带报的额度（Claude 的 rate_limit_event.rate_limit_info）。不转发给主控端，只交给节点记下 */
  | { kind: "rate_limit"; info: unknown };

export type ParserVerdict =
  | { ok: true; finalText: string }
  | { ok: false; reason: "incomplete_output" | "internal" | "quota_exhausted"; message: string };

export interface OutputParser {
  /** 输入一段 stdout 文本（已经是完整的 UTF-8 字符），返回解析出的事件 */
  push(chunk: string): ParserOutput[];
  /** 进程结束时调用：处理最后一行（可能没有换行），给出结论 */
  finish(): { trailing: ParserOutput[]; verdict: ParserVerdict };
}

/**
 * 服务商的错误信息是不是"额度用尽 / 被限流"。
 *
 * 只用在解析器**已经确认是错误**的消息上（Claude 的 is_error 结果、Codex 的 turn.failed / error、
 * DeepSeek 脚本的 error 行），不会拿正常回答去匹配。匹配不上就当普通错误，不猜。
 */
const QUOTA_PATTERNS = [
  /usage limit/i,
  /rate[ _-]?limit/i,
  /\bquota\b/i,
  /insufficient[ _]balance/i,
  /too many requests/i,
  /\b429\b/,
  /\b402\b/,
];

/**
 * 「… limit」里不是额度的那几种（C-49 / A-03）：上下文满了、--max-budget-usd 花完了、轮数到了。
 * 这些重试也没用，但不是「额度用尽」：报成缺席会让讨论去找替补、聊天显示「额度缺席」，方向就错了。
 * 「Context limit reached」「You've hit your context limit」两种说法都要排除（汐 #219），所以这里不带 reached。
 */
const NOT_QUOTA_LIMITS = /\b(context|budget|turns?|tokens?|output|length|size)( window| length)? limit\b/i;

/**
 * 只靠「limit」字样判断的两种说法（上面那些明确的词没命中时才看）：
 * - Claude Code 2.x：「You've hit your limit · resets 3pm」「You've hit your session limit」
 * - 「5-hour limit reached」「Weekly limit reached」
 * 都要先排除 NOT_QUOTA_LIMITS。
 */
const HIT_LIMIT = /\bhit (your|the)( [a-z0-9-]+){0,3} limit\b/i;
const LIMIT_REACHED = /limit reached/i;

export function looksLikeQuota(message: string): boolean {
  if (QUOTA_PATTERNS.some((p) => p.test(message))) return true;
  if (NOT_QUOTA_LIMITS.test(message)) return false;
  return HIT_LIMIT.test(message) || LIMIT_REACHED.test(message);
}

export function errorVerdict(message: string): ParserVerdict {
  const trimmed = message.slice(0, 1000);
  return looksLikeQuota(message)
    ? { ok: false, reason: "quota_exhausted", message: trimmed }
    : { ok: false, reason: "internal", message: trimmed };
}

/** 按行切分的 JSON Lines 解析器：负责缓冲、CRLF、非 JSON 行原样转发 */
export abstract class JsonLinesParser implements OutputParser {
  private buffer = "";

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

  finish(): { trailing: ParserOutput[]; verdict: ParserVerdict } {
    const trailing: ParserOutput[] = [];
    if (this.buffer.trim()) this.handleLine(this.buffer.replace(/\r$/, ""), trailing);
    this.buffer = "";
    return { trailing, verdict: this.verdict() };
  }

  protected abstract handleObject(o: Record<string, unknown>, out: ParserOutput[]): void;
  protected abstract verdict(): ParserVerdict;

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
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    this.handleObject(obj as Record<string, unknown>, out);
  }
}
