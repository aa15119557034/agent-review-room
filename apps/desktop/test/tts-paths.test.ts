import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { findTtsBundle, TTS_MODEL_VERSION, TTS_RUNTIME_VERSION } from "../src/main/tts-paths";

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

function fakeInstall(options: { runtime?: string; model?: string; skip?: string } = {}): string {
  const install = mkdtempSync(join(tmpdir(), "room-tts-"));
  dirs.push(install);
  const base = join(install, "tts");
  mkdirSync(join(base, "python"), { recursive: true });
  mkdirSync(join(base, "site-packages"), { recursive: true });
  mkdirSync(join(base, "index-tts"), { recursive: true });
  mkdirSync(join(base, "models", "IndexTTS-2"), { recursive: true });
  writeFileSync(join(base, "python", "python.exe"), "");
  writeFileSync(join(base, "runner.py"), "");
  if (options.skip !== "runtime") {
    writeFileSync(join(base, "runtime.json"), JSON.stringify({ version: options.runtime ?? TTS_RUNTIME_VERSION }));
  }
  if (options.skip !== "model") {
    writeFileSync(
      join(base, "models", "IndexTTS-2", "model.json"),
      JSON.stringify({ version: options.model ?? TTS_MODEL_VERSION }),
    );
  }
  return install;
}

const execPathOf = (install: string): string => join(install, "评审室.exe");

describe("tts bundle lookup (#195 B 方案)", () => {
  it("安装目录里没有 tts：说明没装、给出该解压哪个包", () => {
    const install = mkdtempSync(join(tmpdir(), "room-tts-"));
    dirs.push(install);
    const lookup = findTtsBundle(execPathOf(install), join(install, "resources"));
    assert.equal(lookup.bundle, null);
    assert.ok(lookup.reason?.includes("没装"));
    assert.ok(lookup.reason?.includes("tts-runtime"));
  });

  it("缺一项：说清楚缺什么", () => {
    const install = fakeInstall();
    rmSync(join(install, "tts", "site-packages"), { recursive: true, force: true });
    const lookup = findTtsBundle(execPathOf(install), join(install, "resources"));
    assert.equal(lookup.bundle, null);
    assert.ok(lookup.reason?.includes("不完整"));
    assert.ok(lookup.reason?.includes("site-packages"));
  });

  it("版本文件缺失 / 版本不对：明确提示重新解压", () => {
    const noRuntime = fakeInstall({ skip: "runtime" });
    assert.ok(findTtsBundle(execPathOf(noRuntime), join(noRuntime, "resources")).reason?.includes("runtime.json"));

    const wrong = fakeInstall({ model: "indextts2-0.9.0" });
    const lookup = findTtsBundle(execPathOf(wrong), join(wrong, "resources"));
    assert.equal(lookup.bundle, null);
    assert.ok(lookup.reason?.includes("版本不对"));
  });

  it("齐全时给出五个路径和版本；exe 旁边优先于 resources", () => {
    const install = fakeInstall();
    // resources/tts 也放一份旧的，确认优先用 exe 旁边
    const resources = join(install, "resources");
    mkdirSync(join(resources, "tts"), { recursive: true });
    const lookup = findTtsBundle(execPathOf(install), resources);
    assert.ok(lookup.bundle !== null);
    assert.equal(lookup.bundle.baseDir, join(install, "tts"));
    assert.equal(lookup.bundle.python, join(install, "tts", "python", "python.exe"));
    assert.equal(lookup.bundle.sitePackages, join(install, "tts", "site-packages"));
    assert.equal(lookup.bundle.runtimeVersion, TTS_RUNTIME_VERSION);
    assert.equal(lookup.bundle.modelVersion, TTS_MODEL_VERSION);
  });

  it("旧的 resources/tts 布局仍然兼容", () => {
    const install = mkdtempSync(join(tmpdir(), "room-tts-"));
    dirs.push(install);
    const resources = join(install, "resources");
    mkdirSync(join(resources, "tts"), { recursive: true });
    writeFileSync(join(resources, "tts", "runtime.json"), JSON.stringify({ version: TTS_RUNTIME_VERSION }));
    mkdirSync(join(resources, "tts", "python"), { recursive: true });
    mkdirSync(join(resources, "tts", "site-packages"), { recursive: true });
    mkdirSync(join(resources, "tts", "index-tts"), { recursive: true });
    mkdirSync(join(resources, "tts", "models", "IndexTTS-2"), { recursive: true });
    writeFileSync(join(resources, "tts", "python", "python.exe"), "");
    writeFileSync(join(resources, "tts", "runner.py"), "");
    writeFileSync(
      join(resources, "tts", "models", "IndexTTS-2", "model.json"),
      JSON.stringify({ version: TTS_MODEL_VERSION }),
    );
    const lookup = findTtsBundle(execPathOf(install), resources);
    assert.ok(lookup.bundle !== null);
    assert.equal(lookup.bundle.baseDir, join(resources, "tts"));
  });
});
