import { createHash } from "node:crypto";
import type { RunModel, StartRunAttachment, VisionSupport } from "@room/schemas";
import type { Profile } from "./config";

/**
 * S-23：节点收图、交图（契约 C-42a / C-42g，ADR-004 §2）。
 *
 * - 收：逐张解码 base64，字节数和 sha256 都要和请求里写的一致（清单块、图片位置标记的格式和位置由 schema 先查过）
 * - 核对看图能力：看这一次实际用的模型（ModelOption.vision / fixedModelVision），只有 "yes" 才收
 * - 交：按 profile.images.input 把「标记前文字 → 图片块（按编号）→ 标记后文字」写进 stdin。
 *   节点不加、不删、不改任何文字（标记本身留在前一段末尾），所以文字部分拼起来和 content 逐字相同。
 *   都走 stdin，不落临时文件
 */

export type VerifiedImage = { index: number; mime: StartRunAttachment["mime"]; data: string };

/** 逐张核对，返回问题描述；全部对上返回 null */
export function attachmentProblem(attachments: readonly StartRunAttachment[]): string | null {
  for (const a of attachments) {
    const bytes = Buffer.from(a.data, "base64");
    if (bytes.length !== a.bytes) return `attachment ${a.index}: decoded size does not match bytes`;
    // Buffer.from 遇到非法字符会悄悄跳过；重新编码对得上才算标准 base64
    if (bytes.toString("base64") !== a.data) return `attachment ${a.index}: data is not canonical base64`;
    if (createHash("sha256").update(bytes).digest("hex") !== a.sha256) {
      return `attachment ${a.index}: sha256 does not match the bytes`;
    }
  }
  return null;
}

/** 这一次实际用的模型能不能看图。没传 model 时只有模型写死的 profile 才有答案 */
export function visionOf(profile: Pick<Profile, "models" | "fixedModelVision">, model: RunModel | undefined): VisionSupport {
  if (model === undefined) return profile.models.length === 0 ? (profile.fixedModelVision ?? "unknown") : "unknown";
  return profile.models.find((m) => m.id === model.model)?.vision ?? "unknown";
}

/** profile 里有没有任何一个模型报了能看图（决定 health.capabilities.attachments） */
export function profileMaySeeImages(profile: Profile): boolean {
  return profile.images !== undefined && (profile.fixedModelVision === "yes" || profile.models.some((m) => m.vision === "yes"));
}

/** 按图片位置标记切开 content：标记留在前一段末尾 */
export function splitAtSlot(content: string, slot: string): { before: string; after: string } {
  const at = content.indexOf(slot);
  if (at === -1 || content.indexOf(slot, at + 1) !== -1) throw new Error("image slot must occur exactly once");
  const cut = at + slot.length;
  return { before: content.slice(0, cut), after: content.slice(cut) };
}

/**
 * 带图时交给 CLI 的 stdin。
 * - claude-stream-json：`claude -p --input-format stream-json` 的一条 user 消息，content 是文字块和图片块（base64）
 * - openai-content-json：本仓库脚本（bin/deepseek-chat.mjs --input-format content-json）读的一份 JSON，
 *   content 按 OpenAI chat 的格式（text / image_url 用 data: URL）
 * 空文字段不写块（CLI 不接受空文字块）
 */
export function imageStdin(
  input: NonNullable<Profile["images"]>["input"],
  content: string,
  slot: string,
  images: readonly VerifiedImage[],
): string {
  const { before, after } = splitAtSlot(content, slot);
  const ordered = [...images].sort((a, b) => a.index - b.index);
  if (input === "claude-stream-json") {
    const blocks = [
      ...(before ? [{ type: "text", text: before }] : []),
      ...ordered.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })),
      ...(after ? [{ type: "text", text: after }] : []),
    ];
    return JSON.stringify({ type: "user", message: { role: "user", content: blocks } }) + "\n";
  }
  const blocks = [
    ...(before ? [{ type: "text", text: before }] : []),
    ...ordered.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } })),
    ...(after ? [{ type: "text", text: after }] : []),
  ];
  return JSON.stringify({ content: blocks });
}
