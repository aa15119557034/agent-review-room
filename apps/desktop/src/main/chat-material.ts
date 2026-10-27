import type { ChatMessage } from "@room/schemas";

/** 转议题时材料的字符上限，和 Message.content 的上限一致 */
export const CHAT_MATERIAL_MAX_CHARS = 2_000_000;

/**
 * 转议题时给最终 Prompt 留的余量：边界标签、本轮任务、本轮历史都加在材料外面，
 * 节点对 StartRunRequest.snapshot.content 的上限也是 2,000,000（remote-protocol.ts）。
 * 材料超过「上限 − 余量」就不让建议题，免得议题建出来却永远发不出去；
 * 超出余量的部分（比如任务特别长）由 discussion.ts 的 assertPromptFits 在起草时兜住。
 */
export const CHAT_MATERIAL_PROMPT_HEADROOM = 32_768;

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
