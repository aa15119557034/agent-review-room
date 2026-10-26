import type { ChatMessage } from "@room/schemas";

/** 转议题时材料的字符上限，和 Message.content 的上限一致 */
export const CHAT_MATERIAL_MAX_CHARS = 2_000_000;

/**
 * 把选中的聊天消息整理成议题的初始材料（纯文本）。
 *
 * - 谁、什么时候、说了什么，按时间顺序
 * - 语音用转写文字、表情用说明、图片 / 文件用「[图片：文件名]」占位
 * - 不拼 Prompt、不加标签：材料之后按讨论室的附件规则进不可信边界
 */
export function renderChatMaterial(
  messages: readonly ChatMessage[],
  displayNameOf: (agentId: string) => string,
): string {
  const lines: string[] = ["从聊天会话转来的 " + messages.length + " 条消息："];
  for (const message of messages) {
    const who = message.sender === "user" ? "你" : displayNameOf(message.agent);
    let text: string;
    if (message.sender === "agent") {
      text = message.text;
    } else {
      const content = message.content;
      if (content.kind === "text") {
        const attachments = content.attachments.map((attachment) =>
          attachment.kind === "image" ? "[图片：" + attachment.name + "]" : "[文件：" + attachment.name + "]",
        );
        text = [content.text, ...attachments].filter((part) => part.length > 0).join("\n");
      } else if (content.kind === "voice") {
        text = "[语音] " + content.transcript.text;
      } else {
        text = "[表情] " + content.label;
      }
    }
    lines.push("[" + message.createdAt + "] " + who + "：" + text);
  }
  return lines.join("\n\n");
}
