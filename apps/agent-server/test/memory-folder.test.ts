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
    const dir = agentDir({ "core/b.md": "b", "core/B.md": "B", "core/a.txt": "a", "notes/n.md": "n" });
    assert.deepEqual(ids(selectMemory(dir)), ["core/B.md", "core/a.txt", "core/b.md", "notes/n.md"]);
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

  const noSentinel = (s: MemorySelection) => {
    if (s.status !== "unavailable") for (const e of s.entries) assert.ok(!e.text.includes("SENTINEL"), e.id);
  };

  it("file and directory symlinks in notes are skipped", () => {
    const dir = agentDir({ "core/a.md": "c" });
    mkdirSync(join(dir, "notes"));
    symlinkSync(join(outside, "agent-server.token"), join(dir, "notes", "token.md"));
    symlinkSync(join(outside, "dir"), join(dir, "notes", "linked"), "dir");
    const sel = selectMemory(dir);
    assert.deepEqual(ids(sel), ["core/a.md"]);
    noSentinel(sel);
    assert.ok(sel.warnings.some((w) => w.includes("notes/token.md")));
    assert.ok(sel.warnings.some((w) => w.includes("notes/linked")));
  });

  it("a symlinked notes/ or core/ section is refused", () => {
    const dir = agentDir({ "core/a.md": "c" });
    symlinkSync(join(outside, "dir"), join(dir, "notes"), "dir");
    noSentinel(selectMemory(dir));
    const dir2 = agentDir({});
    symlinkSync(join(outside, "dir"), join(dir2, "core"), "dir");
    assert.match(reason(selectMemory(dir2)), /core/);
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

  it("memory folder whose real path leaves homeDir/memory/<agent> is refused", () => {
    const realpath = (p: string) => (p.endsWith("deepseek") ? "E:\\elsewhere\\deepseek" : p);
    assert.match(identityProblems(cfg(), probe({ realpath })).join(), /真实路径/);
  });

  it("a node without memory and without agent keeps working as before", () => {
    const old = ServerConfig.parse({ nodeId: "n", profiles: { "claude-review": { command: "claude", cwd: "." }, "codex-discuss": { command: "codex", cwd: "." } } });
    assert.deepEqual(identityProblems(old, probe({ currentUser: () => "jianghao" })), []);
  });
});
