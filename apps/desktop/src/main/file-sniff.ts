import { sniffImage } from "./image";

/**
 * 按文件头判断一个「非图片」文件是什么（D-34a，契约 C-34 的 ChatAttachment.file）。
 *
 * 只看字节，不看扩展名。判断顺序：
 * 1. 图片（png / jpeg / webp / gif）——用户把图当文件选了也照样认；动图这里不管，聊天文件不渲染
 * 2. PDF（%PDF-）、ZIP（PK\x03\x04；docx / xlsx / pptx 也是 zip，mime 先记成 application/zip）
 * 3. 能按 UTF-8 读、而且没有 NUL 字节的，当文本（txt / md / csv / json / 代码）
 * 4. 其余 application/octet-stream
 *
 * isText = true 才允许把文件正文放进 Prompt（X-34 拼装时用）。
 */

export interface SniffedFile {
  mime: string;
  isText: boolean;
}

const IMAGE_MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
} as const;

export function sniffFile(bytes: Buffer): SniffedFile {
  const image = sniffImage(bytes);
  if (image !== null) return { mime: IMAGE_MIME[image.kind], isText: false };

  if (bytes.length >= 5 && bytes.toString("latin1", 0, 5) === "%PDF-") return { mime: "application/pdf", isText: false };
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return { mime: "application/zip", isText: false };
  }
  if (isUtf8Text(bytes)) return { mime: "text/plain", isText: true };
  return { mime: "application/octet-stream", isText: false };
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** 能完整按 UTF-8 解码、而且没有 NUL（二进制文件里几乎一定有） */
function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  if (bytes.includes(0)) return false;
  try {
    decoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}
