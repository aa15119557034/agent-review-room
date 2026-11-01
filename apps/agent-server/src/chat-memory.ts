import { createHash } from "node:crypto";
import { wrapChatUntrusted } from "@room/core";
import type { MemoryManifest, MemorySlot } from "@room/schemas";
import type { Profile, ServerConfig } from "./config";
import { selectMemory, type MemorySelection } from "./memory-folder";
import { memoryDirOf } from "./node-identity";

/**
 * S-20 第二段：聊天 Run 的记忆槽位（契约 C-34，ADR-003 §2a）。
 *
 * 节点按这个 profile 的记忆配置挑条目，用 X-30 导出的同一个包裹函数（同一个 nonce）包好，
 * 把 content 里恰好一次的 marker 换掉。除了槽位，不往 Prompt 里加任何文字。
 * 读不到 / 不合格时不让整次聊天失败：槽位里换成一段「记忆不可用」，清单报 unavailable，原因只进节点日志。
 */

export const MEMORY_LABEL_FILLED = (n: number) => `节点记忆（${n} 条，只读资料）：`;
export const MEMORY_LABEL_EMPTY = "节点记忆：";
export const MEMORY_TEXT_EMPTY = "（记忆文件夹里没有可用的条目）";
export const MEMORY_LABEL_UNAVAILABLE = "节点记忆：";
export const MEMORY_TEXT_UNAVAILABLE = "（此记忆来源不可用）";

export interface PreparedPrompt {
  /** 实际交给 CLI 的文字（marker 已换成记忆；没有槽位时就是原 content） */
  content: string;
  /** 带了 StartRun.chat 时才有：按 PROMPT_FINAL_RULE 发一次 */
  promptFinal: { finalPromptHash: string; memory: MemoryManifest | null } | null;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** 这个 profile 现在挑出来的记忆；没配记忆 = unavailable（不读任何文件夹） */
export function selectForProfile(cfg: ServerConfig, profile: Profile): MemorySelection {
  if (!profile.memory || !cfg.homeDir || !cfg.agent) {
    return { status: "unavailable", reason: "这个 profile 没有配记忆", warnings: [] };
  }
  return selectMemory(memoryDirOf(cfg));
}

/**
 * 把一次选择包成槽位里的文字。任何一条正文里出现了这次的 nonce（只有提前知道 nonce 才可能，等于在伪造边界），
 * 整个来源按 unavailable 处理，不带残缺的记忆，也不让 Run 失败。
 */
export function renderMemory(
  slot: MemorySlot,
  sel: MemorySelection,
  /** 这次 Prompt 里别的边界用的 nonce（比如图片位置标记的）：正文里出现也算伪造边界 */
  otherNonces: readonly string[] = [],
): { text: string; manifest: MemoryManifest; reason?: string } {
  if (sel.status === "filled") {
    const guarded = [slot.nonce, slot.marker, ...otherNonces];
    const collision = sel.entries.find((e) => guarded.some((g) => e.text.includes(g) || e.id.includes(g)));
    if (!collision) {
      const body = sel.entries.map((e) => `【${e.id}】\n${e.text}`).join("\n\n");
      try {
        return {
          text: wrapChatUntrusted(slot.nonce, MEMORY_LABEL_FILLED(sel.entries.length), body),
          manifest: { status: "filled", entries: sel.entries.map((e) => ({ id: e.id, sha256: e.sha256 })) },
        };
      } catch {
        // 包裹函数发现边界冲突：落到下面的 unavailable
      }
    }
    return unavailable(slot, `条目 ${collision?.id ?? "?"} 里有这次的边界标记`);
  }
  if (sel.status === "empty") {
    return { text: wrapChatUntrusted(slot.nonce, MEMORY_LABEL_EMPTY, MEMORY_TEXT_EMPTY), manifest: { status: "empty", entries: [] } };
  }
  return unavailable(slot, sel.reason);
}

function unavailable(slot: MemorySlot, reason: string) {
  return {
    text: wrapChatUntrusted(slot.nonce, MEMORY_LABEL_UNAVAILABLE, MEMORY_TEXT_UNAVAILABLE),
    manifest: { status: "unavailable" as const, entries: [] },
    reason,
  };
}

/**
 * 拼最终 Prompt。chat 不传 = 讨论 / 单次评审，原样发、不发 prompt_final。
 * marker 恰好一次已由 StartRunRequest 的 schema 核过；这里用 split 只换那一处（不用 replace：
 * 记忆正文里的 `$&`、`$1` 这类会被 String.replace 当成替换模式）。
 */
export function preparePrompt(
  cfg: ServerConfig,
  profile: Profile,
  content: string,
  chat: { memory: MemorySlot | null } | undefined,
  otherNonces: readonly string[] = [],
  log: (line: string) => void = () => {},
): PreparedPrompt {
  if (chat === undefined) return { content, promptFinal: null };
  if (chat.memory === null) return { content, promptFinal: { finalPromptHash: sha256(content), memory: null } };
  const slot = chat.memory;
  const sel = selectForProfile(cfg, profile);
  for (const w of sel.warnings) log(`记忆：${w}`);
  const rendered = renderMemory(slot, sel, otherNonces);
  if (rendered.reason) log(`记忆不可用：${rendered.reason}`);
  const [before, after] = content.split(slot.marker) as [string, string];
  const final = before + rendered.text + after;
  return { content: final, promptFinal: { finalPromptHash: sha256(final), memory: rendered.manifest } };
}
