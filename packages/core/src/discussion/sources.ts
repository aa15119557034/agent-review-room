import { SourceReferences, type SourceReference } from "@room/schemas";
import { estimateTokens, sha256Hex } from "../prompt";
import { wrapChatUntrusted } from "./chat";

/** A derived Prompt view. The caller resolves authorization and exact original bytes immediately before this call. */
export function withSourceContext<T extends { content: string; contentHash: string; nonce: string; tokenEstimate: number }>(
  prompt: T,
  sources: readonly { reference: SourceReference; content: string | null }[],
): T & { sourceRefs?: SourceReference[] } {
  if (sources.length === 0) return prompt;
  const unique = [...new Map(sources.map((source) => [JSON.stringify(source.reference), source])).values()];
  const sourceRefs = SourceReferences.parse(unique.map((source) => source.reference));
  const blocks = unique.map(({ reference, content }) => {
    const location = reference.source.kind === "web" ? reference.source.url : reference.source.id;
    if (reference.status === "readable" && (content === null || sha256Hex(content) !== reference.contentHash)) {
      throw new Error("readable source must match its original text hash");
    }
    return wrapChatUntrusted(prompt.nonce, "资料引用", JSON.stringify({ source: location, version: reference.version, status: reference.status }) +
      (reference.status === "readable" ? "\n" + content : "\n（资料不可用，不得补造原文）"));
  });
  const content = prompt.content + "\n\n" + blocks.join("\n");
  if (content.length > 2_000_000) throw new Error("source context exceeds the existing prompt limit");
  return { ...prompt, content, contentHash: sha256Hex(content), tokenEstimate: estimateTokens(content), sourceRefs };
}
