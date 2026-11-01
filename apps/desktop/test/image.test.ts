import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import sharp from "sharp";
import { ATTACHMENT_LIMITS } from "@room/schemas";
import { ImageRejectedError, processImage, sniffImage } from "../src/main/image";

/** 用 sharp 现造测试图（100×60 的纯色），不往仓库里放二进制固定文件 */
const base = () =>
  sharp({ create: { width: 100, height: 60, channels: 3, background: { r: 10, g: 20, b: 30 } } });

const jpegWithExif = () =>
  base()
    .jpeg({ quality: 80 })
    .withMetadata({ exif: { IFD0: { ImageDescription: "secret-note", Software: "probe" } } })
    .toBuffer();

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("image pipeline (D-36a)", () => {
  it("keeps the original format, strips metadata, and is byte-for-byte deterministic", async () => {
    const input = await jpegWithExif();
    assert.ok((await sharp(input).metadata()).exif !== undefined, "fixture really has EXIF");

    const first = await processImage(input);
    const second = await processImage(input);
    assert.equal(first.mime, "image/jpeg");
    assert.deepEqual([first.width, first.height], [100, 60]);
    assert.ok(first.bytes.equals(second.bytes), "same input, same bytes");
    assert.equal(first.sha256, createHash("sha256").update(first.bytes).digest("hex"));
    assert.equal(first.bytes.length, second.bytes.length);

    const out = await sharp(first.bytes).metadata();
    assert.equal(out.format, "jpeg");
    assert.equal(out.exif, undefined, "metadata is gone");
    assert.equal(out.orientation, undefined);
    // 原始 EXIF 里的文字也不该留在输出里
    assert.equal(first.bytes.includes(Buffer.from("secret-note", "latin1")), false);

    for (const make of [
      () => base().png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer(),
      () => base().webp({ quality: 90, effort: 4, smartSubsample: false }).toBuffer(),
    ]) {
      const bytes = await make();
      const processed = await processImage(bytes);
      assert.equal(processed.mime, bytes[0] === 0x89 ? "image/png" : "image/webp");
      const meta = await sharp(processed.bytes).metadata();
      assert.equal(meta.format, bytes[0] === 0x89 ? "png" : "webp");
    }
  });

  it("applies the EXIF orientation and drops the marker", async () => {
    const rotated = await base()
      .jpeg({ quality: 80 })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const processed = await processImage(rotated);
    assert.deepEqual([processed.width, processed.height], [60, 100], "90° turns the frame");
    const meta = await sharp(processed.bytes).metadata();
    assert.equal(meta.orientation, undefined);
    assert.deepEqual([meta.width, meta.height], [60, 100]);
  });

  it("shrinks the long edge to maxEdgePx and keeps the aspect ratio", async () => {
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg({ quality: 70 })
      .toBuffer();
    const processed = await processImage(big);
    assert.equal(Math.max(processed.width, processed.height), ATTACHMENT_LIMITS.maxEdgePx);
    assert.equal(processed.width, 2048);
    assert.equal(processed.height, 1365, "2000 / 3000 × 2048，四舍五入");
  });

  it("keeps transparency (stickers are png with alpha)", async () => {
    const rgba = await sharp({
      create: { width: 40, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
    })
      .png()
      .toBuffer();
    const processed = await processImage(rgba);
    const meta = await sharp(processed.bytes).metadata();
    assert.equal(meta.hasAlpha, true);
    const stats = await sharp(processed.bytes).stats();
    assert.ok((stats.channels[3]?.mean ?? 0) > 100, "alpha channel is still there");
  });

  it("rejects GIF, HEIC, APNG, animated WebP, unknown bytes, and broken files", async () => {
    const reject = async (input: Buffer, code: ImageRejectedError["code"]) => {
      await assert.rejects(
        () => processImage(input),
        (error: unknown) => error instanceof ImageRejectedError && error.code === code,
        `${code} expected`,
      );
    };

    await reject(Buffer.from("GIF89a" + "x".repeat(20), "latin1"), "unsupported_type");

    const heif = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(12)]);
    assert.deepEqual(sniffImage(heif), { kind: "heic" });
    await reject(heif, "unsupported_type");

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // rgba
    const apng = Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("acTL", Buffer.alloc(8)), chunk("IEND", Buffer.alloc(0))]);
    assert.deepEqual(sniffImage(apng), { kind: "png", animated: true });
    await reject(apng, "animated");

    const vp8xData = Buffer.alloc(10);
    vp8xData[0] = 0x02; // 动画标志
    const animWebp = Buffer.concat([
      Buffer.from("RIFF", "latin1"),
      Buffer.alloc(4),
      Buffer.from("WEBP", "latin1"),
      Buffer.from("VP8X", "latin1"),
      Buffer.from([vp8xData.length, 0, 0, 0]),
      vp8xData,
    ]);
    assert.deepEqual(sniffImage(animWebp), { kind: "webp", animated: true });
    await reject(animWebp, "animated");

    await reject(Buffer.from("not an image"), "unsupported_type");
    await reject(Buffer.alloc(0), "unsupported_type");
    await reject(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("garbage-garbage-garbage")]), "decode_failed");
  });

  it("enforces the input / pixel / output limits (limits overridden for the test)", async () => {
    const input = await jpegWithExif();
    await assert.rejects(() => processImage(input, { inputMaxBytes: 10 }), (e: unknown) => e instanceof ImageRejectedError && e.code === "input_too_big");
    await assert.rejects(() => processImage(input, { inputMaxPixels: 1000 }), (e: unknown) => e instanceof ImageRejectedError && e.code === "pixel_limit");
    await assert.rejects(() => processImage(input, { imageMaxBytes: 1 }), (e: unknown) => e instanceof ImageRejectedError && e.code === "output_too_big");
    // 默认上限下这张图通过
    assert.equal((await processImage(input)).mime, "image/jpeg");
  });
});
