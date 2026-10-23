import { z } from "zod";
import { Sha256Hex } from "./common";
import { ImageMime } from "./appearance";

/**
 * 图片附件（C-42a，ADR-004 §2，阶段 1B-M1）。
 *
 * 图片处理（main，D-36a）：
 * - 解码前：输入不超过 ATTACHMENT_LIMITS.inputMaxBytes、像素不超过 inputMaxPixels（防解压炸弹）；动图和 HEIC 拒绝（validation_failed）
 * - 解码 → 按方向信息转正 → 转 sRGB → 长边缩到 maxEdgePx → 按原格式重新编码，**不带任何元数据**
 *   （EXIF、XMP、IPTC、PNG 文字块、内嵌缩略图全部丢掉）
 * - 输出确定：固定编码库版本和参数、不写时间戳，同一张输入每次处理出来字节相同
 * - 处理后超过 imageMaxBytes：validation_failed
 *
 * 指纹（D-36b）：
 * - Snapshot 的 content 里写附件清单，每张一行 `attachmentManifestLine(entry)`，放在不可信资料区；
 *   文件名另行转义后放在同一区里（拼装归 X-34）。contentHash = sha256(content) 的算法不变，所以清单变了 hash 就变
 * - PromptSnapshot.attachments 存这份清单（权威），BatchItem.attachments 是同一份，给确认页显示
 * - batch.approve 和起跑前，main 各重新读一次每个文件、算 sha256 和清单比对，任何一张对不上 → 整批 stale_snapshot，不建 Run
 * - StartRun.attachments 带上字节；节点检查每张 sha256 和字节一致、并且 content 里含有它的清单行，否则 hash_mismatch
 *
 * 能不能看图看**这一次所用的模型**：ModelOption.vision（见 remote-protocol.ts）。
 */

/** 节点实测的看图能力。没测过就是 unknown，按看不了处理（发占位文字），界面写「还没测过」 */
export const VisionSupport = z.enum(["yes", "no", "unknown"]);
export type VisionSupport = z.infer<typeof VisionSupport>;

export const ATTACHMENT_LIMITS = {
  /** 处理前：原文件最大字节数 */
  inputMaxBytes: 20 * 1024 * 1024,
  /** 处理前：最大像素数（宽 × 高） */
  inputMaxPixels: 40_000_000,
  /** 处理后：长边像素 */
  maxEdgePx: 2048,
  /** 处理后：单张最大字节数 */
  imageMaxBytes: 2 * 1024 * 1024,
  /** 一条消息（聊天）或一条议题材料最多几张 */
  perMessage: 4,
  /** 一个 Snapshot 最多几张（超出的按 ADR-004 §2 的优先级换成文字占位） */
  perSnapshot: 8,
  /** 一个 Snapshot 的图片合计字节数 */
  perSnapshotBytes: 12 * 1024 * 1024,
} as const;

/** 节点 StartRun 请求体上限要不小于这个数（附件 base64 后约 16 MB，加上文字） */
export const NODE_MIN_BODY_BYTES_WITH_ATTACHMENTS = 16 * 1024 * 1024;

/** 清单里的编号，从 1 开始，在一个 Snapshot 内连续 */
export const AttachmentIndex = z.number().int().min(1).max(ATTACHMENT_LIMITS.perSnapshot);

export const AttachmentManifestEntry = z
  .object({
    index: AttachmentIndex,
    /** 给人看的名字（原文件名）。进 Prompt 前由拼装器转义，只放在资料区 */
    name: z.string().min(1).max(120),
    mime: ImageMime,
    bytes: z.number().int().min(1).max(ATTACHMENT_LIMITS.imageMaxBytes),
    sha256: Sha256Hex,
  })
  .strict();
export type AttachmentManifestEntry = z.infer<typeof AttachmentManifestEntry>;

/** 一个 Snapshot 的附件清单：编号 1..n 连续、同一张图不重复、合计字节有上限 */
export const AttachmentManifest = z
  .array(AttachmentManifestEntry)
  .max(ATTACHMENT_LIMITS.perSnapshot)
  .refine((xs) => xs.every((x, i) => x.index === i + 1), "编号要从 1 开始连续")
  .refine((xs) => new Set(xs.map((x) => x.sha256)).size === xs.length, "同一张图在一个 Snapshot 里只出现一次")
  .refine(
    (xs) => xs.reduce((n, x) => n + x.bytes, 0) <= ATTACHMENT_LIMITS.perSnapshotBytes,
    "图片合计超过 perSnapshotBytes",
  );
export type AttachmentManifest = z.infer<typeof AttachmentManifest>;

/**
 * 清单在 content 里的一行（不含文件名，文件名由拼装器转义后另写）。节点用它确认附件确实在被批准的内容里。
 * 格式固定，改格式要改契约。
 */
export const attachmentManifestLine = (e: Pick<AttachmentManifestEntry, "index" | "mime" | "bytes" | "sha256">): string =>
  `[附件 ${e.index}] ${e.mime} ${e.bytes} bytes sha256=${e.sha256}`;

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

/** StartRun 里随附的一张图。只有 attachments 能力的节点才会收到 */
export const StartRunAttachment = z
  .object({
    index: AttachmentIndex,
    mime: ImageMime,
    bytes: z.number().int().min(1).max(ATTACHMENT_LIMITS.imageMaxBytes),
    sha256: Sha256Hex,
    /** 标准 base64（带 = 补齐，不换行） */
    data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict()
  .refine((a) => a.data.length === base64Length(a.bytes), "data 长度和 bytes 对不上");
export type StartRunAttachment = z.infer<typeof StartRunAttachment>;

export const StartRunAttachments = z
  .array(StartRunAttachment)
  .min(1)
  .max(ATTACHMENT_LIMITS.perSnapshot)
  .refine((xs) => xs.every((x, i) => x.index === i + 1), "编号要从 1 开始连续")
  .refine(
    (xs) => xs.reduce((n, x) => n + x.bytes, 0) <= ATTACHMENT_LIMITS.perSnapshotBytes,
    "图片合计超过 perSnapshotBytes",
  );
export type StartRunAttachments = z.infer<typeof StartRunAttachments>;
