import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ServerConfig } from "../src/config";
import { compareCodePoints, selectMemory, type MemorySelection } from "../src/memory-folder";
import { identityProblems, type IdentityProbe } from "../src/node-identity";

/** S-20：内置「文件夹」记忆读法（ADR-003 §2a）和节点身份检查 */

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function agentDir(files: Record<string, string>, settings: unknown = { version: 1, budgetChars: 1_000, maxFileBytes: 4_096 }): string {
  // settings 传 null = 不建 memory.json
  const root = mkdtempSync(join(tmpdir(), "mem-"));
  roots.push(root);
  const dir = join(root, "memory", "deepseek");
  mkdirSync(dir, { recursive: true });
  if (settings !== null) writeFileSync(join(dir, "memory.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const ids = (s: MemorySelection) => (s.status === "unavailable" ? assert.fail(`unavailable: ${s.reason}`) : s.entries.map((e) => e.id));
const reason = (s: MemorySelection) => (s.status === "unavailable" ? s.reason : assert.fail(`expected unavailable, got ${s.status}`));
const touch = (dir: string, rel: string, sec: number) => utimesSync(join(dir, rel), sec, sec);

describe("memory.json", () => {
  it("missing, broken, unknown version, extra field or out of range → unavailable (no clamping)", () => {
    const bad: unknown[] = [
      null,
      "{not json",
      { version: 2, budgetChars: 1_000, maxFileBytes: 4_096 },
      { version: 1, budgetChars: 1_000, maxFileBytes: 4_096, extra: true },
      { version: 1, budgetChars: 999, maxFileBytes: 4_096 },
      { version: 1, budgetChars: 50_001, maxFileBytes: 4_096 },
      { version: 1, budgetChars: 1_000, maxFileBytes: 4_095 },
      { version: 1, budgetChars: 1_000, maxFileBytes: 1_048_577 },
    ];
    for (const s of bad) assert.match(reason(selectMemory(agentDir({ "core/a.md": "a" }, s))), /memory\.json/, JSON.stringify(s));
  });

  it("folder missing → unavailable", () => {
    assert.match(reason(selectMemory(join(tmpdir(), "no-such-memory-folder-s20"))), /不存在/);
  });
});

describe("core", () => {
  it("is always first, sorted by code point, and missing / empty core is unavailable", () => {
    assert.match(reason(selectMemory(agentDir({ "notes/a.md": "a" }))), /core 不存在或是空的/);
    assert.match(reason(selectMemory(agentDir({ "core/readme.bin": "x", "notes/a.md": "a" }))), /core 不存在或是空的/);
    // 不用 b.md / B.md 这种只差大小写的一对：Windows 上它们是同一个文件
    const dir = agentDir({ "core/b.md": "b", "core/C.md": "C", "core/a.txt": "a", "notes/n.md": "n" });
    assert.deepEqual(ids(selectMemory(dir)), ["core/C.md", "core/a.txt", "core/b.md", "notes/n.md"]);
  });

  it("over budget, over maxFileBytes, non-UTF-8 or > 200 files → whole source unavailable", () => {
    assert.match(reason(selectMemory(agentDir({ "core/a.md": "x".repeat(600), "core/b.md": "y".repeat(401) }))), /超过 budgetChars/);
    assert.match(reason(selectMemory(agentDir({ "core/a.md": "a", "core/big.md": "x".repeat(4_097) }))), /maxFileBytes/);
    const dir = agentDir({ "core/a.md": "a" });
    writeFileSync(join(dir, "core", "bad.md"), Buffer.from([0xff, 0xfe, 0x00]));
    assert.match(reason(selectMemory(dir)), /UTF-8/);
    const many: Record<string, string> = {};
    for (let i = 0; i < 201; i++) many[`core/${String(i).padStart(3, "0")}.md`] = "x";
    assert.match(reason(selectMemory(agentDir(many, { version: 1, budgetChars: 50_000, maxFileBytes: 4_096 }))), /超过 200/);
  });

  it("budget counts code points, not UTF-16 units or bytes", () => {
    // 600 个 😀 = 600 码点 / 1200 UTF-16 单元 / 2400 字节；预算 1000 放得下
    const sel = selectMemory(agentDir({ "core/a.md": "😀".repeat(600) }, { version: 1, budgetChars: 1_000, maxFileBytes: 4_096 }));
    assert.deepEqual(ids(sel), ["core/a.md"]);
  });
});

describe("journal and notes", () => {
  it("journal goes newest date first by path (both name forms, any mtime), then notes newest mtime first", () => {
    const dir = agentDir({
      "core/a.md": "c",
      "journal/2025/12-31.md": "j1",
      "journal/2026/01-02-trip.md": "j2",
      "journal/2026/01-02.md": "j3",
      "journal/2026/1-3.md": "bad name",
      "journal/notes.md": "bad place",
      "notes/old.md": "n1",
      "notes/sub/new.md": "n2",
      "notes/same-b.md": "n3",
      "notes/same-a.md": "n4",
    });
    // mtime 故意和日期反着来，journal 不看 mtime
    touch(dir, "journal/2025/12-31.md", 3_000);
    touch(dir, "journal/2026/01-02.md", 1_000);
    touch(dir, "notes/old.md", 1_000);
    touch(dir, "notes/sub/new.md", 5_000);
    touch(dir, "notes/same-a.md", 2_000);
    touch(dir, "notes/same-b.md", 2_000);
    const sel = selectMemory(dir);
    assert.deepEqual(ids(sel), [
      "core/a.md",
      "journal/2026/01-02-trip.md",
      "journal/2026/01-02.md",
      "journal/2025/12-31.md",
      "notes/sub/new.md",
      "notes/same-a.md",
      "notes/same-b.md",
      "notes/old.md",
    ]);
    assert.ok(sel.warnings.some((w) => w.includes("journal/2026/1-3.md")));
    assert.ok(sel.warnings.some((w) => w.includes("journal/notes.md")));
  });

  it("journal dates that do not exist are skipped; non-.md/.txt files (even dotfiles like .gitkeep) are ignored, also in core", () => {
    const dir = agentDir({ "core/a.md": "c", "core/.gitkeep": "", "core/readme.bin": "x", "journal/2026/02-31.md": "x", "journal/2024/02-29.md": "leap" });
    const sel = selectMemory(dir);
    assert.deepEqual(ids(sel), ["core/a.md", "journal/2024/02-29.md"]);
    assert.ok(sel.warnings.some((w) => w.includes("02-31") && w.includes("日期不存在")));
  });

  it("folders nested deeper than 16 levels are skipped", () => {
    const deep = `notes/${Array.from({ length: 17 }, (_, i) => `d${i}`).join("/")}/x.md`;
    const sel = selectMemory(agentDir({ "core/a.md": "c", [deep]: "x", "notes/d0/y.md": "y" }));
    assert.deepEqual(ids(sel), ["core/a.md", "notes/d0/y.md"]);
    assert.ok(sel.warnings.some((w) => w.includes("嵌套超过")));
  });

  it("an entry that does not fit is skipped and later shorter ones still go in; stops at 200 entries", () => {
    const dir = agentDir({ "core/a.md": "c".repeat(500), "journal/2026/01-02.md": "x".repeat(600), "journal/2026/01-01.md": "y".repeat(400) });
    assert.deepEqual(ids(selectMemory(dir)), ["core/a.md", "journal/2026/01-01.md"]);
    const many: Record<string, string> = { "core/a.md": "c" };
    for (let i = 0; i < 250; i++) many[`notes/${String(i).padStart(3, "0")}.md`] = "n";
    assert.equal(ids(selectMemory(agentDir(many, { version: 1, budgetChars: 50_000, maxFileBytes: 4_096 }))).length, 200);
  });

  it("skips hidden, oversized, non-UTF-8 and too-long ids with a warning; ignores inbox and ext", () => {
    const long = `notes/${"d".repeat(195)}.md`; // id 超过 200 字符
    const dir = agentDir({
      "core/a.md": "c",
      "notes/.hidden.md": "h",
      "notes/big.md": "x".repeat(4_097),
      [long]: "l",
      "inbox/i.md": "i",
      "ext/plg/e.md": "e",
      "notes/ok.md": "ok",
    });
    writeFileSync(join(dir, "notes", "bad.md"), Buffer.from([0xc3, 0x28]));
    const sel = selectMemory(dir);
    assert.deepEqual(ids(sel), ["core/a.md", "notes/ok.md"]);
    for (const id of ["notes/.hidden.md", "notes/big.md", "notes/bad.md", long]) assert.ok(sel.warnings.some((w) => w.includes(id)), id);
  });

  it("entry sha256 is over the UTF-8 text with the BOM removed", () => {
    const dir = agentDir({ "core/a.md": "\uFEFF身份" });
    const sel = selectMemory(dir);
    assert.equal(sel.status, "filled");
    const e = sel.status === "filled" ? sel.entries[0]! : assert.fail();
    assert.equal(e.text, "身份");
    assert.equal(e.sha256, createHash("sha256").update("身份", "utf8").digest("hex"));
  });

  it("copying with times preserved gives the same selection", () => {
    const dir = agentDir({ "core/a.md": "c", "notes/x.md": "x".repeat(400), "notes/y.md": "y".repeat(400), "notes/z.md": "z".repeat(400) });
    touch(dir, "notes/x.md", 1_000);
    touch(dir, "notes/y.md", 3_000);
    touch(dir, "notes/z.md", 2_000);
    const copy = join(mkdtempSync(join(tmpdir(), "mem-copy-")), "deepseek");
    roots.push(dirname(copy));
    cpSync(dir, copy, { recursive: true, preserveTimestamps: true });
    const a = selectMemory(dir);
    const b = selectMemory(copy);
    assert.deepEqual(ids(b), ids(a));
    assert.deepEqual(ids(a), ["core/a.md", "notes/y.md", "notes/z.md"]);
  });
});

describe("links never leave the memory folder", () => {
  const outside = mkdtempSync(join(tmpdir(), "mem-outside-"));
  roots.push(outside);
  writeFileSync(join(outside, "agent-server.token"), "SENTINEL-TOKEN");
  mkdirSync(join(outside, "dir"));
  writeFileSync(join(outside, "dir", "secret.md"), "SENTINEL-DIR");

  // Windows 上文件夹用 junction（不需要管理员）；文件符号链接要开发者模式或管理员，建不了就跳过那一步
  const dirLink = (target: string, path: string) => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
  const fileLink = (target: string, path: string): boolean => {
    try {
      symlinkSync(target, path, "file");
      return true;
    } catch (err) {
      if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") return false;
      throw err;
    }
  };

  const noSentinel = (s: MemorySelection) => {
    if (s.status !== "unavailable") for (const e of s.entries) assert.ok(!e.text.includes("SENTINEL"), e.id);
  };

  it("file symlinks and directory links (junctions on Windows) in notes are skipped", (t) => {
    const dir = agentDir({ "core/a.md": "c" });
    mkdirSync(join(dir, "notes"));
    const madeFileLink = fileLink(join(outside, "agent-server.token"), join(dir, "notes", "token.md"));
    if (!madeFileLink) t.diagnostic("Windows 普通权限建不了文件符号链接：这一步没测（junction 照测）");
    dirLink(join(outside, "dir"), join(dir, "notes", "linked.md"));
    dirLink(join(outside, "dir"), join(dir, "notes", "linked"));
    const sel = selectMemory(dir);
    assert.deepEqual(ids(sel), ["core/a.md"]);
    noSentinel(sel);
    if (madeFileLink) assert.ok(sel.warnings.some((w) => w.includes("notes/token.md")));
    assert.ok(sel.warnings.some((w) => w.includes("notes/linked.md")));
  });

  it("links whose names are not .md / .txt are ignored like other non-memory files, also in core", () => {
    const dir = agentDir({ "core/a.md": "c" });
    dirLink(join(outside, "dir"), join(dir, "core", "link.bin"));
    dirLink(join(outside, "dir"), join(dir, "core", ".gitkeep"));
    const sel = selectMemory(dir);
    assert.deepEqual(ids(sel), ["core/a.md"]);
    noSentinel(sel);
  });

  it("a linked notes/ or core/ section is refused", () => {
    const dir = agentDir({ "core/a.md": "c" });
    dirLink(join(outside, "dir"), join(dir, "notes"));
    noSentinel(selectMemory(dir));
    const dir2 = agentDir({});
    dirLink(join(outside, "dir"), join(dir2, "core"));
    assert.match(reason(selectMemory(dir2)), /core/);
  });

  it("memory.json that is a link or hard link is refused before reading", (t) => {
    const big = join(outside, "big.json");
    writeFileSync(big, " ".repeat(10_000) + JSON.stringify({ version: 1, budgetChars: 1_000, maxFileBytes: 4_096 }));
    const dir = agentDir({ "core/a.md": "c" }, null);
    linkSync(big, join(dir, "memory.json"));
    assert.match(reason(selectMemory(dir)), /硬链接/);
    const dir3 = agentDir({ "core/a.md": "c" }, null);
    writeFileSync(join(dir3, "memory.json"), " ".repeat(4_097));
    assert.match(reason(selectMemory(dir3)), /太大/);
    const dir4 = agentDir({ "core/a.md": "c" }, null);
    mkdirSync(join(dir4, "memory.json"));
    assert.match(reason(selectMemory(dir4)), /不是普通文件/);
    const dir2 = agentDir({ "core/a.md": "c" }, null);
    if (fileLink(big, join(dir2, "memory.json"))) assert.match(reason(selectMemory(dir2)), /不是普通文件/);
    else t.diagnostic("Windows 普通权限建不了文件符号链接：这一步没测");
  });

  it("hard links are skipped (they are not reparse points)", () => {
    const dir = agentDir({ "core/a.md": "c" });
    mkdirSync(join(dir, "notes"));
    linkSync(join(outside, "agent-server.token"), join(dir, "notes", "hard.md"));
    const sel = selectMemory(dir);
    assert.deepEqual(ids(sel), ["core/a.md"]);
    noSentinel(sel);
    assert.ok(sel.warnings.some((w) => w.includes("硬链接")));
    // core 里的硬链接让整个来源不可用
    const dir2 = agentDir({ "core/a.md": "c" });
    linkSync(join(outside, "agent-server.token"), join(dir2, "core", "hard.md"));
    assert.match(reason(selectMemory(dir2)), /硬链接/);
  });
});

describe("compareCodePoints", () => {
  it("orders by code point (supplementary plane after BMP), case-sensitive", () => {
    const list = ["b", "😀", "a", "B", "\uFF5E"];
    assert.deepEqual([...list].sort(compareCodePoints), ["B", "a", "b", "\uFF5E", "😀"]);
  });
});

describe("identityProblems", () => {
  const probe = (over: Partial<IdentityProbe> = {}): IdentityProbe => ({
    currentUser: () => "HOST\\agentroom-deepseek",
    volume: () => ({ format: "NTFS", type: "Fixed" }),
    realpath: (p) => p,
    isLink: () => false,
    platform: "win32",
    ...over,
  });
  const cfg = (over: Record<string, unknown> = {}, profiles?: Record<string, unknown>) =>
    ServerConfig.parse({
      nodeId: "n",
      homeDir: "D:\\AgentRoom",
      agent: "deepseek",
      runAsUser: "agentroom-deepseek",
      profiles: profiles ?? {
        "deepseek-discuss": { command: "node", cwd: "." },
        "deepseek-chat": { command: "node", cwd: ".", memory: { dir: "memory/deepseek", provider: "folder" } },
      },
      ...over,
    });

  it("accepts the documented layout", () => {
    assert.deepEqual(identityProblems(cfg(), probe()), []);
  });

  it("refuses the wrong account (e.g. started from 江浩's session)", () => {
    assert.match(identityProblems(cfg(), probe({ currentUser: () => "jianghao" })).join(), /必须以账号 agentroom-deepseek 运行/);
  });

  it("runAsUser is required with memory and must be agentroom-<agent>", () => {
    assert.match(identityProblems(cfg({ runAsUser: undefined }), probe({ currentUser: () => "jianghao" })).join(), /必须填 runAsUser/);
    for (const u of ["jianghao", "agentroom-codex", "HOST\\agentroom-codex"]) {
      assert.match(identityProblems(cfg({ runAsUser: u }), probe({ currentUser: () => u })).join(), /runAsUser 只能是 agentroom-deepseek/, u);
    }
    assert.deepEqual(identityProblems(cfg({ runAsUser: "HOST\\agentroom-deepseek" }), probe()), []);
  });

  it("refuses another secretary's profiles on this node (Codex never runs under 汐's account)", () => {
    const p = identityProblems(cfg({}, { "deepseek-chat": { command: "node", cwd: "." }, "codex-discuss": { command: "codex", cwd: "." } }), probe());
    assert.match(p.join(), /codex-discuss" 不属于 deepseek/);
  });

  it("memory only on -chat profiles, dir only memory/<agent>, agent and homeDir required", () => {
    const withMem = (id: string, dir: string) => ({ [id]: { command: "node", cwd: ".", memory: { dir, provider: "folder" } } });
    assert.match(identityProblems(cfg({}, withMem("deepseek-discuss", "memory/deepseek")), probe()).join(), /只有聊天 profile/);
    assert.match(identityProblems(cfg({}, withMem("deepseek-chat", "memory/codex")), probe()).join(), /只能是 memory\/deepseek/);
    assert.match(identityProblems(cfg({}, withMem("deepseek-chat", "C:\\Users\\x")), probe()).join(), /只能是 memory\/deepseek/);
    assert.match(identityProblems(cfg({ agent: undefined }), probe()).join(), /必须填 agent/);
    assert.match(identityProblems(cfg({ homeDir: undefined }), probe()).join(), /必须填 homeDir/);
  });

  it("homeDir must be on a local NTFS volume", () => {
    for (const v of [{ format: "exFAT", type: "Fixed" }, { format: "FAT32", type: "Removable" }, { format: "NTFS", type: "Network" }, { format: "NTFS", type: "Removable" }]) {
      assert.match(identityProblems(cfg(), probe({ volume: () => v })).join(), /本机 NTFS/, JSON.stringify(v));
    }
    assert.match(identityProblems(cfg(), probe({ volume: () => null })).join(), /查不到/);
  });

  it("homeDir that is a link / junction / mount point is refused, and the volume is checked on the real path", () => {
    const toShare = (p: string) => p.replace("D:\\AgentRoom", "\\\\server\\share\\AgentRoom");
    let checked = "";
    const volume = (p: string) => {
      checked = p;
      return { format: "NTFS", type: "Fixed" };
    };
    assert.match(identityProblems(cfg(), probe({ realpath: toShare, volume })).join(), /不能是链接或 junction/);
    assert.match(identityProblems(cfg(), probe({ realpath: () => null })).join(), /不存在或读不了/);
    // 卷挂载点：真实路径字符串不变，但路径本身（或上级）是重解析点
    assert.match(identityProblems(cfg(), probe({ isLink: (p) => p === "D:\\AgentRoom" })).join(), /挂载点/);
    assert.match(identityProblems(cfg(), probe({ isLink: (p) => p === "D:\\" })).join(), /挂载点/);
    identityProblems(cfg(), probe({ realpath: (p) => p.replace("D:", "d:"), volume }));
    assert.equal(checked, "d:\\AgentRoom");
  });

  it("memory folder whose real path leaves homeDir/memory/<agent> is refused", () => {
    const realpath = (p: string) => (p.endsWith("deepseek") ? "E:\\elsewhere\\deepseek" : p);
    assert.match(identityProblems(cfg(), probe({ realpath })).join(), /真实路径/);
  });

  it("a node without memory and without agent keeps working as before", () => {
    const old = ServerConfig.parse({ nodeId: "n", profiles: { "claude-review": { command: "claude", cwd: "." }, "codex-discuss": { command: "codex", cwd: "." } } });
    assert.deepEqual(identityProblems(old, probe({ currentUser: () => "jianghao" })), []);
  });
});
