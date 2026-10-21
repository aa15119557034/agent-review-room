import { ClaudeStreamJsonParser } from "./claude-stream-json";
import { CodexExecJsonParser } from "./codex-exec-json";
import type { OutputParser } from "./common";
import { RoomJsonlParser } from "./room-jsonl";

export type { OutputParser, ParserOutput, ParserVerdict } from "./common";

export const PARSERS = ["raw", "claude-stream-json", "codex-exec-json", "room-jsonl"] as const;
export type ParserName = (typeof PARSERS)[number];

/** raw 没有解析器：stdout 原样转发，退出码 0 就算完成 */
export function createParser(name: ParserName): OutputParser | null {
  switch (name) {
    case "raw":
      return null;
    case "claude-stream-json":
      return new ClaudeStreamJsonParser();
    case "codex-exec-json":
      return new CodexExecJsonParser();
    case "room-jsonl":
      return new RoomJsonlParser();
  }
}
