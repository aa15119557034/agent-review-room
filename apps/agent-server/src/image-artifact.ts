import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RemoteArtifact } from "@room/schemas";

/**
 * S-23：image Run（契约 C-42b）画出来的图。
 *
 * 归属必须能证明（林离 #131）：节点给每个 image Run 新建一个**只属于这次 Run** 的目录
 * `<imageRun.outputDir>/<runId>`，通过 args 里的 `{image-output-dir}` 和环境变量 ROOM_IMAGE_OUTPUT_DIR 交给 CLI，
 * 只从这个目录里取图，结束后只删这个目录。共享目录（例如 Codex 默认的 $CODEX_HOME/generated_images）
 * 里的文件节点一概不碰：那里的文件归属证明不了。
 * - 按文件头判断类型（只认 png / jpeg / webp），不看扩展名；最多 10 MB（RemoteArtifact 上限）
 * - 目录里有多张时取最新的一张
 * 字节留在节点内存里，主控端用 artifacts 端点取回；取回后或结束超过 leaseMs 没人取就丢掉。
 */

export const ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_OUTPUT_DIR_PLACEHOLDER = "{image-output-dir}";
export const IMAGE_OUTPUT_DIR_ENV = "ROOM_IMAGE_OUTPUT_DIR";

export interface HeldArtifact {
  meta: RemoteArtifact;
  bytes: Buffer;
}

/** 这次 Run 的输出目录。runId 已按契约校验（run_ + ULID），不会带路径分隔符 */
export function runOutputDir(root: string, runId: string): string {
  if (!/^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(runId)) throw new Error("unexpected runId");
  return join(root, runId);
}

/** 新建这次 Run 的目录；已经存在就失败（不接管别人的目录） */
export function createRunOutputDir(dir: string): void {
  mkdirSync(join(dir, ".."), { recursive: true });
  mkdirSync(dir); // 不加 recursive：目录已存在会抛 EEXIST
}

export function removeRunOutputDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function sniffImageMime(b: Buffer): RemoteArtifact["mime"] | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** 从这次 Run 自己的目录里取最新的一张图。只读这个目录；删除由调用方删整个目录 */
export function collectArtifact(dir: string): HeldArtifact | { problem: string } {
  let names: string[];
  try {
    names = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return { problem: "image output directory is missing" };
  }
  const files: Array<{ path: string; mtime: number; size: number }> = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const s = statSync(path);
      if (s.isFile()) files.push({ path, mtime: s.mtimeMs, size: s.size });
    } catch {
      // 列目录和 stat 之间被删了，跳过
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  let tooLarge = false;
  for (const f of files) {
    if (f.size > ARTIFACT_MAX_BYTES) {
      tooLarge = true;
      continue;
    }
    if (f.size === 0) continue;
    const bytes = readFileSync(f.path);
    const mime = sniffImageMime(bytes);
    if (!mime) continue;
    return { meta: { sha256: createHash("sha256").update(bytes).digest("hex"), mime, bytes: bytes.length }, bytes };
  }
  return { problem: tooLarge ? "generated image is larger than 10 MB" : "no generated image found" };
}
