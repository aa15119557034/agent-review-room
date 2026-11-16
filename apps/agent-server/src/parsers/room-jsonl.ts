/**
 * 本项目自带脚本（目前是 bin/deepseek-chat.mjs）的输出格式，每行一个 JSON：
 *
 *   {"type":"delta","text":"…"}                                  增量文字
 *   {"type":"done","text":"完整回复","finishReason":"stop"}        正常结束（必须有这一行才算完成）
 *   {"type":"error","message":"…","quota":true|false}            失败；quota=true 表示额度用尽或限流
 *
 * 这个格式只在本仓库内部使用，由脚本和解析器一起维护。
 */
import { JsonLinesParser, type ParserOutput, type ParserVerdict } from "./common";
import { ResultDisplay } from "@room/schemas";

export class RoomJsonlParser extends JsonLinesParser {
  private done: string | null = null;
  private error: { message: string; quota: boolean } | null = null;

  protected handleObject(o: Record<string, unknown>, out: ParserOutput[]): void {
    if (o["type"] === "result_display") {
      const parsed = ResultDisplay.safeParse(o["result"]);
      if (!parsed.success || Object.keys(o).some((key) => key !== "type" && key !== "result")) this.error = { message: "invalid structured display result", quota: false };
      else out.push({ kind: "result_display", result: parsed.data });
    } else if (o["type"] === "delta" && typeof o["text"] === "string") {
      out.push({ kind: "text_delta", text: o["text"] as string });
    } else if (o["type"] === "done" && typeof o["text"] === "string") {
      this.done = o["text"] as string;
    } else if (o["type"] === "error") {
      this.error = {
        message: typeof o["message"] === "string" ? (o["message"] as string) : "error",
        quota: o["quota"] === true,
      };
    }
  }

  protected verdict(): ParserVerdict {
    if (this.error) {
      return { ok: false, reason: this.error.quota ? "quota_exhausted" : "internal", message: this.error.message.slice(0, 1000) };
    }
    if (this.done === null) return { ok: false, reason: "incomplete_output", message: "输出在 done 之前中断" };
    return { ok: true, finalText: this.done };
  }
}
