import { createHash } from "node:crypto";
import sharp from "sharp";
import { ATTACHMENT_LIMITS, type ImageMime } from "@room/schemas";

/**
 * 图片处理管道（D-36a，契约 C-42a / ADR-004 §2）。
 *
 * 输入 → 输出：
 * - 解码前：字节不超过 inputMaxBytes、像素不超过 inputMaxPixels（防解压炸弹）；动图和 HEIC 直接拒绝
 * - 解码 → 按方向信息转正 → 转 sRGB → 长边缩到 maxEdgePx → **按原格式**重新编码，不带任何元数据
 *   （EXIF、XMP、IPTC、PNG 文字块、内嵌缩略图全部丢掉）
 * - 输出确定：编码参数固定、不写时间戳，同一张输入每次处理出来字节相同
 * - 处理后超过 imageMaxBytes：拒绝
 *
 * 类型只认文件头，不看扩展名：只放行 png / jpeg / webp（和 ImageMime 一致）；GIF（静态和动图都算）、
 * APNG、动画 WebP、HEIC 一律拒绝。
 *
 * 这里只做「字节 → 字节」，怎么存、引用怎么记是 D-36b 的事。
 */

export type ImageRejectionCode =
  | "input_too_big"
  | "unsupported_type"
  | "animated"
  | "pixel_limit"
  | "decode_failed"
  | "output_too_big";

/** 拒绝这张图。调用方把它翻成 validation_failed（message 直接给用户看） */
export class ImageRejectedError extends Error {
  readonly code: ImageRejectionCode;

  constructor(code: ImageRejectionCode, message: string) {
    super(message);
    this.name = "ImageRejectedError";
    this.code = code;
  }
}

export interface ProcessedImage {
  mime: ImageMime;
  bytes: Buffer;
  /** 处理之后的尺寸（已经按方向转正、缩过） */
  width: number;
  height: number;
  /** 处理之后字节的 sha256（去重和附件清单都用它） */
  sha256: string;
}

export interface ProcessImageLimits {
  inputMaxBytes: number;
  inputMaxPixels: number;
  maxEdgePx: number;
  imageMaxBytes: number;
}

const DEFAULT_LIMITS: ProcessImageLimits = {
  inputMaxBytes: ATTACHMENT_LIMITS.inputMaxBytes,
  inputMaxPixels: ATTACHMENT_LIMITS.inputMaxPixels,
  maxEdgePx: ATTACHMENT_LIMITS.maxEdgePx,
  imageMaxBytes: ATTACHMENT_LIMITS.imageMaxBytes,
};

const MIME_OF: Readonly<Record<"png" | "jpeg" | "webp", ImageMime>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export type SniffedImage =
  | { kind: "png" | "jpeg" | "webp"; animated: boolean }
  | { kind: "gif" }
  | { kind: "heic" };

/** 按文件头判断类型；不认识的返回 null。只读字节，不解码 */
export function sniffImage(bytes: Buffer): SniffedImage | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: "png", animated: pngIsApng(bytes) };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: "jpeg", animated: false };
  }
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    return { kind: "webp", animated: webpIsAnimated(bytes) };
  }
  if (bytes.length >= 6 && (bytes.toString("latin1", 0, 6) === "GIF87a" || bytes.toString("latin1", 0, 6) === "GIF89a")) {
    return { kind: "gif" };
  }
  if (bytes.length >= 12 && bytes.toString("latin1", 4, 8) === "ftyp") {
    const brands = heifBrands(bytes);
    // HEIF 家族：heic / heix / hevc / hevx（静态或序列）/ mif1 / msf1（通用 HEIF 容器）
    if (brands.some((b) => ["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis", "avif"].includes(b))) {
      return { kind: "heic" };
    }
  }
  return null;
}

/** PNG 的 chunk 列表里有没有 acTL（有就是 APNG）。只看 chunk 头，碰到 IDAT 就停 */
function pngIsApng(bytes: Buffer): boolean {
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    offset += 12 + length;
  }
  return false;
}

/** WebP：有 ANIM chunk，或 VP8X 的动画标志位（0x02）就当作动图 */
function webpIsAnimated(bytes: Buffer): boolean {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (type === "ANIM") return true;
    if (type === "VP8X") {
      const flags = bytes[offset + 8] ?? 0;
      return (flags & 0x02) !== 0;
    }
    offset += 8 + size + (size % 2);
  }
  return false;
}

/** ISOBMFF：major brand + 兼容 brand 列表 */
function heifBrands(bytes: Buffer): string[] {
  const brands: string[] = [];
  const major = bytes.toString("latin1", 8, 12);
  brands.push(major);
  const boxSize = bytes.length >= 16 ? bytes.readUInt32BE(0) : 0;
  const end = Math.min(bytes.length, boxSize === 0 ? bytes.length : boxSize);
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    brands.push(bytes.toString("latin1", offset, offset + 4));
  }
  return brands;
}

/**
 * 处理一张图。成功返回处理后的字节、尺寸和 sha256；不合格抛 ImageRejectedError。
 * limits 只给测试用（默认就是契约里的 ATTACHMENT_LIMITS），业务代码不要传。
 */
export async function processImage(input: Buffer, limits: Partial<ProcessImageLimits> = {}): Promise<ProcessedImage> {
  const l: ProcessImageLimits = { ...DEFAULT_LIMITS, ...limits };
  if (input.length === 0) throw new ImageRejectedError("unsupported_type", "这个文件是空的");
  if (input.length > l.inputMaxBytes) {
    throw new ImageRejectedError(
      "input_too_big",
      `图片太大了（${mb(input.length)} MB，上限 ${mb(l.inputMaxBytes)} MB）`,
    );
  }

  const sniffed = sniffImage(input);
  if (sniffed === null) throw new ImageRejectedError("unsupported_type", "只支持 png / jpeg / webp 图片");
  if (sniffed.kind === "gif") throw new ImageRejectedError("unsupported_type", "GIF（包括动图）不支持，请换成 png / jpeg / webp");
  if (sniffed.kind === "heic") throw new ImageRejectedError("unsupported_type", "HEIC 不支持，请先导出成 jpeg 或 png");
  if (sniffed.animated) throw new ImageRejectedError("animated", "动图不支持（APNG / 动画 WebP 也不行）");

  // 先把尺寸读出来自己判像素上限：比等解码器报错更可控，也不会先吃掉大块内存
  let width: number;
  let height: number;
  try {
    const meta = await sharp(input, { limitInputPixels: false }).metadata();
    if (meta.width === undefined || meta.height === undefined) throw new Error("no dimensions");
    width = meta.width;
    height = meta.height;
  } catch {
    throw new ImageRejectedError("decode_failed", "这张图读不出来，可能文件坏了");
  }
  if (width * height > l.inputMaxPixels) {
    throw new ImageRejectedError("pixel_limit", `图片尺寸太大（${width}×${height}，上限 ${l.inputMaxPixels} 像素）`);
  }

  let output: Buffer;
  let outWidth: number;
  let outHeight: number;
  try {
    let pipeline = sharp(input, { limitInputPixels: l.inputMaxPixels, animated: false, failOn: "error" })
      // 按 EXIF 方向转正（转完之后方向标记自然没了）
      .rotate()
      .toColourspace("srgb");
    const longEdge = Math.max(width, height);
    if (longEdge > l.maxEdgePx) {
      pipeline = pipeline.resize({
        width: l.maxEdgePx,
        height: l.maxEdgePx,
        fit: "inside",
        withoutEnlargement: true,
        kernel: "lanczos3",
        fastShrinkOnLoad: false,
      });
    }
    const encoded = encodeFor(sniffed.kind, pipeline);
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    output = data;
    outWidth = info.width;
    outHeight = info.height;
  } catch (error) {
    if (error instanceof ImageRejectedError) throw error;
    throw new ImageRejectedError("decode_failed", "这张图处理不了，可能文件坏了");
  }

  if (output.length > l.imageMaxBytes) {
    throw new ImageRejectedError(
      "output_too_big",
      `处理之后还是太大了（${mb(output.length)} MB，上限 ${mb(l.imageMaxBytes)} MB）`,
    );
  }

  return {
    mime: MIME_OF[sniffed.kind],
    bytes: output,
    width: outWidth,
    height: outHeight,
    sha256: createHash("sha256").update(output).digest("hex"),
  };
}

/**
 * 按原格式重新编码。参数全部写死（同一张输入每次输出字节相同），也都不带元数据：
 * - jpeg：mozjpeg 质量 90、4:2:0；png：zlib 9、不用调色板和自适应过滤；webp：质量 90、effort 4
 */
function encodeFor(kind: "png" | "jpeg" | "webp", pipeline: ReturnType<typeof sharp>): ReturnType<typeof sharp> {
  if (kind === "jpeg") return pipeline.jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: "4:2:0" });
  if (kind === "png") return pipeline.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false });
  return pipeline.webp({ quality: 90, effort: 4, smartSubsample: false });
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "");
