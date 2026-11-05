import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import yazl from "yazl";
import type { ControlEvent } from "@room/schemas";
import { PacksService } from "../src/main/packs";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 句柄释放有延迟
    }
  }
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "room-packs-"));
  dirs.push(dir);
  return dir;
}

function write(path: string, content = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

async function makeZip(entries: Record<string, string>): Promise<string> {
  const dir = temp();
  const file = join(dir, "pack.zip");
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name);
  zip.end();
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(require("node:fs").createWriteStream(file)).on("close", resolve).on("error", reject);
  });
  return file;
}

function makeService(options: {
  local: string;
  install?: string;
  resources?: string;
  pick?: string | null;
}): { service: PacksService; events: ControlEvent[] } {
  const events: ControlEvent[] = [];
  const install = options.install ?? temp();
  const resources = options.resources ?? temp();
  const service = new PacksService({
    dialog: {
      showOpenDialog: async () => ({ canceled: options.pick === null || options.pick === undefined, filePaths: options.pick === undefined || options.pick === null ? [] : [options.pick] }),
    },
    installDir: install,
    resourcesPath: resources,
    localAppData: options.local,
    emit: (event) => events.push(event),
  });
  return { service, events };
}

function installRuntime(local: string): void {
  const base = join(local, "评审室", "tts");
  write(join(base, "python", "python.exe"));
  write(join(base, "site-packages", "x.txt"));
  write(join(base, "index-tts", "x.txt"));
  write(join(base, "runtime.json"), JSON.stringify({ version: "1" }));
}

describe("packs service (#209)", () => {
  it("packs.list：没装是 missing，装好 runtime 后是 installed，model 仍 missing", () => {
    const local = temp();
    const { service } = makeService({ local });
    assert.deepEqual(service.list().map((p) => [p.id, p.state]), [["tts-runtime", "missing"], ["tts-model", "missing"]]);
    installRuntime(local);
    assert.deepEqual(service.list().map((p) => [p.id, p.state]), [["tts-runtime", "installed"], ["tts-model", "missing"]]);
  });

  it("导入 zip（自动认包）：解压到 LOCALAPPDATA\评审室\tts，状态变 installed，推 packs.updated", async () => {
    const local = temp();
    const zip = await makeZip({
      "pack.json": JSON.stringify({ id: "tts-model", version: "indextts2-2.0.0" }),
      "models/IndexTTS-2/model.json": JSON.stringify({ version: "indextts2-2.0.0" }),
      "models/IndexTTS-2/config.yaml": "config",
    });
    const { service, events } = makeService({ local, pick: zip });
    const result = await service.import({ type: "packs.import", id: null, mode: "zip" });
    assert.equal(result.error, null);
    assert.equal(result.packId, "tts-model");
    assert.equal(service.list().find((p) => p.id === "tts-model")!.state, "installed");
    assert.ok(existsSync(join(local, "评审室", "tts", "models", "IndexTTS-2", "config.yaml")));
    assert.ok(events.some((e) => e.type === "packs.updated"));
    assert.ok(!existsSync(join(local, "评审室", "tts", ".staging-"), "staging 清掉"));
  });

  it("zip 里的包和指定 id 不一致 → PACK_UNKNOWN，什么也不改", async () => {
    const local = temp();
    const zip = await makeZip({ "pack.json": JSON.stringify({ id: "tts-model", version: "indextts2-2.0.0" }) });
    const { service } = makeService({ local, pick: zip });
    const result = await service.import({ type: "packs.import", id: "tts-runtime", mode: "zip" });
    assert.equal(result.error, "PACK_UNKNOWN");
    assert.equal(service.list().find((p) => p.id === "tts-runtime")!.state, "missing");
  });

  it("没有 pack.json 又没指定 id → PACK_UNKNOWN", async () => {
    const local = temp();
    const zip = await makeZip({ "models/IndexTTS-2/model.json": "x" });
    const { service } = makeService({ local, pick: zip });
    const result = await service.import({ type: "packs.import", id: null, mode: "zip" });
    assert.equal(result.error, "PACK_UNKNOWN");
  });

  it("版本不对 → PACK_VERSION_MISMATCH", async () => {
    const local = temp();
    const zip = await makeZip({
      "pack.json": JSON.stringify({ id: "tts-model", version: "old" }),
      "models/IndexTTS-2/model.json": JSON.stringify({ version: "old" }),
    });
    const { service } = makeService({ local, pick: zip });
    const result = await service.import({ type: "packs.import", id: null, mode: "zip" });
    assert.equal(result.error, "PACK_VERSION_MISMATCH");
  });

  it("文件夹导入：选中包含 pack.json 的目录", async () => {
    const local = temp();
    const source = temp();
    write(join(source, "pack.json"), JSON.stringify({ id: "tts-model", version: "indextts2-2.0.0" }));
    write(join(source, "models", "IndexTTS-2", "model.json"), JSON.stringify({ version: "indextts2-2.0.0" }));
    const { service } = makeService({ local, pick: source });
    const result = await service.import({ type: "packs.import", id: "tts-model", mode: "folder" });
    assert.equal(result.error, null);
    assert.equal(service.list().find((p) => p.id === "tts-model")!.state, "installed");
  });

  it("用户取消选择框 → cancelled，什么也不改", async () => {
    const local = temp();
    const { service } = makeService({ local, pick: null });
    const result = await service.import({ type: "packs.import", id: "tts-model", mode: "zip" });
    assert.equal(result.cancelled, true);
    assert.equal(result.error, null);
  });
});
