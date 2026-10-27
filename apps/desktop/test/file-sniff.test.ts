import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharp from "sharp";
import { sniffFile } from "../src/main/file-sniff";

const png = () =>
  sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png()
    .toBuffer();
const jpeg = () =>
  sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .jpeg()
    .toBuffer();
const webp = () =>
  sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .webp()
    .toBuffer();

const GIF = Buffer.from("GIF89a" + "\x00".repeat(16), "latin1");
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "latin1");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

describe("file sniffing (D-34a)", () => {
  it("recognizes images by magic bytes", async () => {
    assert.deepEqual(sniffFile(await png()), { mime: "image/png", isText: false });
    assert.deepEqual(sniffFile(await jpeg()), { mime: "image/jpeg", isText: false });
    assert.deepEqual(sniffFile(await webp()), { mime: "image/webp", isText: false });
    assert.deepEqual(sniffFile(GIF), { mime: "image/gif", isText: false });
  });

  it("recognizes pdf and zip", () => {
    assert.deepEqual(sniffFile(PDF), { mime: "application/pdf", isText: false });
    assert.deepEqual(sniffFile(ZIP), { mime: "application/zip", isText: false });
  });

  it("treats decodable UTF-8 without NUL as text, everything else as bytes", () => {
    assert.deepEqual(sniffFile(Buffer.from("# 标题\n正文，带中文。")), { mime: "text/plain", isText: true });
    // 有 NUL：二进制
    assert.deepEqual(sniffFile(Buffer.from([0x41, 0x00, 0x42])), {
      mime: "application/octet-stream",
      isText: false,
    });
    // 不是合法 UTF-8
    assert.deepEqual(sniffFile(Buffer.from([0xff, 0xfe, 0xfd])), {
      mime: "application/octet-stream",
      isText: false,
    });
    // 空文件不算文本
    assert.equal(sniffFile(Buffer.alloc(0)).isText, false);
  });
});
