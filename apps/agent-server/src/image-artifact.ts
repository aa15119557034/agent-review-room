import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RemoteArtifact } from "@room/schemas";

/**
 * S-23：image Run（契约 C-42b）画出来的图。
 *
 * CLI 把图写进 profile.imageRun.outputDir（Codex 是 $CODEX_HOME/generated_images，路径不由请求决定）。
 * 起跑前记下目录里已有的文件，进程正常结束后找新出现的图片文件，取最新的一张：
 * - 按文件头判断类型（只认 png / jpeg / webp），不看扩展名
 * - 最多 10 MB（RemoteArtifact 上限）
 * - 读进内存后把这次新出现的文件全部删掉（不在 CLI 的目录里越积越多）
 * 字节留在节点内存里，主控端用 artifacts 端点取回；取回后或结束超过 leaseMs 没人取就丢掉。
 * 同一个 profile 同时只跑一个 image Run（server.ts 里限制），所以「新出现的文件」不会混进别的 Run 的图。
 */

export const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;

export interface HeldArtifact {
  meta: RemoteArtifact;
  bytes: Buffer;
}

type Listing = Map<string, number>; // 路径 → mtimeMs

/** 递归列出目录里的文件。目录不存在 = 空 */
export function listFiles(dir: string): Listing {
  const out: Listing = new Map();
  let names: string[];
  try {
    names = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return out;
  }
  for (const name of names) {
    const p = join(dir, name);
    try {
      const s = statSync(p);
      if (s.isFile()) out.set(p, s.mtimeMs);
    } catch {
      // 列目录和 stat 之间被删了，跳过
    }
  }
  return out;
}

export function sniffImageMime(b: Buffer): RemoteArtifact["mime"] | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * 找这次新出现的图并取走。返回图，或者说明为什么没有（调用方报 error(incomplete_output)）。
 * 无论成败，这次新出现的文件都删掉
 */
export function collectArtifact(dir: string, before: Listing): HeldArtifact | { problem: string } {
  const now = listFiles(dir);
  const fresh = [...now].filter(([p, m]) => before.get(p) !== m).sort((a, b) => b[1] - a[1]);
  try {
    let tooLarge = false;
    for (const [p] of fresh) {
      let size: number;
      try {
        size = statSync(p).size;
      } catch {
        continue;
      }
      if (size > ARTIFACT_MAX_BYTES) {
        tooLarge = true;
        continue;
      }
      if (size === 0) continue;
      const bytes = readFileSync(p);
      const mime = sniffImageMime(bytes);
      if (!mime) continue;
      return {
        meta: { sha256: createHash("sha256").update(bytes).digest("hex"), mime, bytes: bytes.length },
        bytes,
      };
    }
    return { problem: tooLarge ? "generated image is larger than 10 MB" : "no generated image found" };
  } finally {
    for (const [p] of fresh) rmSync(p, { force: true });
  }
}

/** image Run 没正常完成（取消、超时、出错）：把这次新出现的文件删掉，不留在 CLI 的目录里 */
export function discardFresh(dir: string, before: Listing): void {
  for (const [p, m] of listFiles(dir)) if (before.get(p) !== m) rmSync(p, { force: true });
}
