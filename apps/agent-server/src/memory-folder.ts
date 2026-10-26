import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, type BigIntStats } from "node:fs";
import { join, sep } from "node:path";
import { z } from "zod";
import { MemoryEntryId } from "@room/schemas";

/**
 * S-20：内置的「文件夹」记忆读法（ADR-003 §2a）。
 * 只读这位秘书自己的记忆文件夹，按固定规则挑出这次要带的条目；包边界、填槽位、回报清单在别处做（等 X-30 的包裹函数）。
 * 以后的强记忆插件替换的就是这个文件做的事：给出条目，节点照旧包边界、算 hash。
 */

/** 契约 MemoryManifest.entries 的上限 */
export const MEMORY_MAX_ENTRIES = 200;

export const MemorySettings = z
  .object({
    version: z.literal(1),
    /** 按 Unicode 码点数 */
    budgetChars: z.number().int().min(1_000).max(50_000),
    maxFileBytes: z.number().int().min(4_096).max(1_048_576),
  })
  .strict();
export type MemorySettings = z.infer<typeof MemorySettings>;

/** 新建文件夹时写进 memory.json 的值 */
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = { version: 1, budgetChars: 20_000, maxFileBytes: 65_536 };

export interface MemoryEntry {
  /** 相对于这位秘书文件夹的路径，`/` 分隔，例如 core/identity.md */
  id: string;
  text: string;
  /** sha256(UTF-8(text))，text 已去掉 BOM */
  sha256: string;
}

export type MemorySelection =
  | { status: "filled"; entries: MemoryEntry[]; warnings: string[] }
  | { status: "empty"; entries: []; warnings: string[] }
  | { status: "unavailable"; reason: string; warnings: string[] };

interface Candidate {
  id: string;
  path: string;
  stat: BigIntStats;
}

const SECTIONS = ["core", "notes", "journal"] as const;
const JOURNAL_NAME = /^journal\/(\d{4})\/(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(-[^/]+)?\.(md|txt)$/i;
const TEXT_FILE = /\.(md|txt)$/i;

/** 按 Unicode 码点逐个比较：区分大小写，不看区域设置（JS 默认按 UTF-16 单元比，遇到补充平面的字会排错） */
export function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

export const codePointLength = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

const sameOrInside = (root: string, p: string): boolean => {
  const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  return norm(p).startsWith(norm(root.endsWith(sep) ? root : root + sep));
};

export function readMemorySettings(agentDir: string): { ok: true; settings: MemorySettings } | { ok: false; reason: string } {
  const path = join(agentDir, "memory.json");
  let raw: string;
  try {
    // 先 lstat 再读：链接、硬链接、设备文件、大文件都在读之前拒掉
    const st = lstatSync(path, { bigint: true });
    if (!st.isFile()) return { ok: false, reason: "memory.json 不是普通文件" };
    if (st.nlink > 1n) return { ok: false, reason: "memory.json 有硬链接" };
    if (st.size > 4_096n) return { ok: false, reason: "memory.json 太大" };
    const buf = readFileSync(path);
    if (buf.length > 4_096) return { ok: false, reason: "memory.json 太大" };
    raw = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch (err) {
    return { ok: false, reason: `读不了 memory.json：${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "memory.json 不是合法的 JSON" };
  }
  const parsed = MemorySettings.safeParse(json);
  // 越界也不夹紧：悄悄换值会让人以为设置生效了
  if (!parsed.success) return { ok: false, reason: `memory.json 无效：${parsed.error.issues.map((i) => `${i.path.join(".") || "(根)"} ${i.message}`).join("；")}` };
  return { ok: true, settings: parsed.data };
}

/** 子文件夹最多嵌套这么多层 */
const MAX_DEPTH = 16;

/**
 * 列出一个分区下的候选文件。不跟随符号链接 / junction（lstat 看到的链接一律跳过），
 * 子文件夹照样不跟随；真实路径必须还在这位秘书的文件夹里。
 * 不是 .md / .txt 的普通文件直接忽略（包括 .gitkeep 这类），不算问题；「隐藏」只看名字以 . 开头（ADR-003 §2a）。
 * 文件夹按真实路径记 visited、限制深度：万一有 lstat 认不出的重解析点造成环，也不会无限递归。
 */
function listSection(agentRoot: string, section: string, skipped: Map<string, string>): Candidate[] {
  const out: Candidate[] = [];
  const visited = new Set<string>();
  const walk = (dir: string, rel: string, depth: number) => {
    let realDir: string;
    try {
      realDir = realpathSync.native(dir);
    } catch {
      skipped.set(rel, "读不了真实路径");
      return;
    }
    if (!sameOrInside(agentRoot, realDir)) {
      skipped.set(rel, "真实路径不在记忆文件夹里");
      return;
    }
    if (visited.has(realDir)) {
      skipped.set(rel, "文件夹重复出现（环）");
      return;
    }
    visited.add(realDir);
    if (depth > MAX_DEPTH) {
      skipped.set(rel, `嵌套超过 ${MAX_DEPTH} 层`);
      return;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      skipped.set(rel, "读不了文件夹");
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      const id = `${rel}/${name}`;
      let stat: BigIntStats;
      try {
        stat = lstatSync(path, { bigint: true });
      } catch {
        skipped.set(id, "读不了");
        continue;
      }
      if (stat.isFile() && !TEXT_FILE.test(name)) continue; // 别的类型不算候选，也不算问题
      if (name.startsWith(".")) {
        skipped.set(id, "隐藏文件");
        continue;
      }
      if (stat.isSymbolicLink()) {
        skipped.set(id, "符号链接 / junction，不跟随");
        continue;
      }
      if (stat.isDirectory()) {
        walk(path, id, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        skipped.set(id, "不是普通文件");
        continue;
      }
      let real: string;
      try {
        real = realpathSync.native(path);
      } catch {
        skipped.set(id, "读不了真实路径");
        continue;
      }
      if (!sameOrInside(agentRoot, real)) {
        skipped.set(id, "真实路径不在记忆文件夹里");
        continue;
      }
      out.push({ id, path, stat });
    }
  };
  const top = join(agentRoot, section);
  let st: BigIntStats;
  try {
    st = lstatSync(top, { bigint: true });
  } catch {
    return out; // 分区不存在：core 由调用方判断，notes / journal 可以没有
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    skipped.set(section, "不是普通文件夹");
    return out;
  }
  walk(top, section, 0);
  return out;
}

/** 读一个候选；不合格返回原因 */
function readCandidate(c: Candidate, settings: MemorySettings): { entry: MemoryEntry } | { reason: string } {
  if (!MemoryEntryId.safeParse(c.id).success) return { reason: "条目 id 不合规（太长或有不允许的字符）" };
  if (c.stat.size > BigInt(settings.maxFileBytes)) return { reason: `超过 maxFileBytes（${c.stat.size} 字节）` };
  // 硬链接不是重解析点，lstat 和 realpath 都看不出来；正常记忆文件不会有第二个链接
  if (c.stat.nlink > 1n) return { reason: "有硬链接" };
  let buf: Buffer;
  try {
    buf = readFileSync(c.path);
  } catch {
    return { reason: "读不了" };
  }
  if (buf.length > settings.maxFileBytes) return { reason: "超过 maxFileBytes" }; // 读的时候变大了
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf); // 默认会去掉开头的 BOM
  } catch {
    return { reason: "不是合法的 UTF-8" };
  }
  return { entry: { id: c.id, text, sha256: createHash("sha256").update(text, "utf8").digest("hex") } };
}

/**
 * 按 ADR-003 §2a 挑记忆。agentDir 是这位秘书的记忆文件夹（`<homeDir>/memory/<agent>`），调用方已校验过位置。
 * 顺序：core（按 id）→ journal（路径里的日期新的在前，同一天按 id）→ notes（修改时间新的在前，相同按 id）。
 * core 不截断，有问题整个来源 unavailable；journal / notes 放得下就放、放不下跳过继续，到 200 条停。
 */
export function selectMemory(agentDir: string): MemorySelection {
  const warnings: string[] = [];
  let root: string;
  try {
    root = realpathSync.native(agentDir);
    if (!lstatSync(root).isDirectory()) return { status: "unavailable", reason: "记忆文件夹不是文件夹", warnings };
  } catch {
    return { status: "unavailable", reason: "记忆文件夹不存在或读不了", warnings };
  }
  const settings = readMemorySettings(root);
  if (!settings.ok) return { status: "unavailable", reason: settings.reason, warnings };
  const { budgetChars } = settings.settings;

  const skipped = new Map<string, string>();
  const [core, notes, journal] = SECTIONS.map((s) => listSection(root, s, skipped)) as [Candidate[], Candidate[], Candidate[]];

  // ---- core：每次都带，一条都不能少
  const coreSkipped = [...skipped].filter(([id]) => id === "core" || id.startsWith("core/"));
  if (coreSkipped.length) {
    const [id, why] = coreSkipped[0]!;
    return { status: "unavailable", reason: `core 里有不合格的文件：${id}（${why}）`, warnings };
  }
  if (core.length === 0) return { status: "unavailable", reason: "core 不存在或是空的", warnings };
  if (core.length > MEMORY_MAX_ENTRIES) return { status: "unavailable", reason: `core 有 ${core.length} 个文件，超过 ${MEMORY_MAX_ENTRIES}`, warnings };
  core.sort((a, b) => compareCodePoints(a.id, b.id));

  const entries: MemoryEntry[] = [];
  let used = 0;
  for (const c of core) {
    const r = readCandidate(c, settings.settings);
    if ("reason" in r) return { status: "unavailable", reason: `core 里有不合格的文件：${c.id}（${r.reason}）`, warnings };
    used += codePointLength(r.entry.text);
    entries.push(r.entry);
  }
  if (used > budgetChars) return { status: "unavailable", reason: `core 合计 ${used} 字，超过 budgetChars ${budgetChars}`, warnings };

  for (const [id, why] of skipped) warnings.push(`跳过 ${id}：${why}`);

  // ---- journal：只认 journal/YYYY/MM-DD(.md|-xxx.md)，按路径里的日期
  const dated: { c: Candidate; key: string }[] = [];
  for (const c of journal) {
    const m = JOURNAL_NAME.exec(c.id);
    if (!m) {
      warnings.push(`跳过 ${c.id}：journal 文件名不合格式（journal/YYYY/MM-DD.md 或 MM-DD-<别的>.md）`);
      continue;
    }
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const day = new Date(Date.UTC(y, mo - 1, d));
    if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) {
      warnings.push(`跳过 ${c.id}：日期不存在`);
      continue;
    }
    dated.push({ c, key: `${m[1]}${m[2]}${m[3]}` });
  }
  dated.sort((a, b) => (a.key === b.key ? compareCodePoints(a.c.id, b.c.id) : a.key < b.key ? 1 : -1));

  // ---- notes：修改时间新的在前，相同按 id
  notes.sort((a, b) => (a.stat.mtimeNs === b.stat.mtimeNs ? compareCodePoints(a.id, b.id) : a.stat.mtimeNs < b.stat.mtimeNs ? 1 : -1));

  for (const c of [...dated.map((d) => d.c), ...notes]) {
    if (entries.length >= MEMORY_MAX_ENTRIES) break;
    const r = readCandidate(c, settings.settings);
    if ("reason" in r) {
      warnings.push(`跳过 ${c.id}：${r.reason}`);
      continue;
    }
    const n = codePointLength(r.entry.text);
    if (used + n > budgetChars) continue; // 放不下就跳过这条，后面更短的可能放得下
    used += n;
    entries.push(r.entry);
  }

  // core 至少一条，所以走到这里一定是 filled；empty 只留给以后的插件读法
  return { status: "filled", entries, warnings };
}
