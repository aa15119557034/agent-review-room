import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

/**
 * 生成应用图标（C-51）。
 *
 *   node scripts/make-icon.mjs
 *
 * 产物（都提交进仓库，打包时 electron-builder 从 build/ 里取）：
 *   build/icon.svg   源图（本脚本写出，改图标就改下面的 SVG）
 *   build/icon.png   1024×1024，开发态 / Linux 的窗口图标
 *   build/icon.ico   Windows 图标，内含 16/24/32/48/64/128/256 七个尺寸（每个都是内嵌 PNG）
 *
 * 图案：深青绿圆角方块 + 白色对话气泡 + 气泡里的对勾（「聊过、评审通过」）。不用文字，小尺寸也认得出。
 */

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = join(here, "..", "build");

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** 大图：有渐变和一点高光 */
const svgLarge = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a8474"/>
      <stop offset="1" stop-color="#27594f"/>
    </linearGradient>
  </defs>
  <rect x="40" y="40" width="944" height="944" rx="212" fill="url(#bg)"/>
  <path fill="#ffffff" d="M300 246h424c57 0 104 47 104 104v252c0 57-47 104-104 104H520L372 822c-14 11-34 1-34-17v-99h-38c-57 0-104-47-104-104V350c0-57 47-104 104-104z"/>
  <path fill="none" stroke="#2f6f62" stroke-width="72" stroke-linecap="round" stroke-linejoin="round" d="M372 478l98 98 186-196"/>
</svg>
`;

/** 小图（≤32px）：去掉渐变和边距，线条加粗，缩小后还看得清 */
const svgSmall = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="0" y="0" width="1024" height="1024" rx="200" fill="#2f6f62"/>
  <path fill="#ffffff" d="M268 190h488c66 0 120 54 120 120v290c0 66-54 120-120 120H530L364 852c-16 13-40 1-40-20V720h-56c-66 0-120-54-120-120V310c0-66 54-120 120-120z"/>
  <path fill="none" stroke="#2f6f62" stroke-width="104" stroke-linecap="round" stroke-linejoin="round" d="M352 452l112 112 208-220"/>
</svg>
`;

async function renderPng(size) {
  const svg = size <= 32 ? svgSmall : svgLarge;
  return sharp(Buffer.from(svg), { density: 72 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}

/** ICO = 6 字节文件头 + 每张图 16 字节目录项 + 图片数据（Vista 起可以直接放 PNG） */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留
  header.writeUInt16LE(1, 2); // 1 = 图标
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 宽，0 表示 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // 高
    entry.writeUInt8(0, 2); // 调色板颜色数
    entry.writeUInt8(0, 3); // 保留
    entry.writeUInt16LE(1, 4); // 色彩平面
    entry.writeUInt16LE(32, 6); // 每像素位数
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

mkdirSync(buildDir, { recursive: true });
writeFileSync(join(buildDir, "icon.svg"), svgLarge, "utf8");
writeFileSync(join(buildDir, "icon.png"), await renderPng(1024));

const images = [];
for (const size of ICO_SIZES) images.push({ size, png: await renderPng(size) });
writeFileSync(join(buildDir, "icon.ico"), buildIco(images));

console.log(`[make-icon] 已生成 ${join(buildDir, "icon.png")}、icon.ico（${ICO_SIZES.join("/")}）`);
