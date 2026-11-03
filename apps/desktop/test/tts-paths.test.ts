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

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "room-tts-"));
  dirs.push(dir);
  return dir;
}

/** 按真实布局造一份：程序在 <install>/评审室.exe，runner.py 在 <install>/resources/tts，语音包解压到 ttsRoot/tts */
function fakeInstall(options: { runtime?: string; model?: string; skip?: string; withRunner?: boolean } = {}): {
  install: string;
  ttsRoot: string;
} {
  const install = temp();
  const resources = join(install, "resources", "tts");
  mkdirSync(resources, { recursive: true });
  if (options.withRunner !== false) writeFileSync(join(resources, "runner.py"), "");
  const ttsRoot = temp();
  const base = join(ttsRoot, "评审室", "tts");
  mkdirSync(join(base, "python"), { recursive: true });
  mkdirSync(join(base, "site-packages"), { recursive: true });
  mkdirSync(join(base, "index-tts"), { recursive: true });
  mkdirSync(join(base, "models", "IndexTTS-2"), { recursive: true });
  writeFileSync(join(base, "python", "python.exe"), "");
  if (options.skip !== "runtime") {
    writeFileSync(join(base, "runtime.json"), JSON.stringify({ version: options.runtime ?? TTS_RUNTIME_VERSION }));
  }
  if (options.skip !== "model") {
    writeFileSync(
      join(base, "models", "IndexTTS-2", "model.json"),
      JSON.stringify({ version: options.model ?? TTS_MODEL_VERSION }),
    );
  }
  return { install, ttsRoot };
}

const input = (install: string, ttsRoot: string) => ({
  execPath: join(install, "评审室.exe"),
  resourcesPath: join(install, "resources"),
  localAppData: ttsRoot,
});

describe("tts bundle lookup (#195 B 方案)", () => {
  it("哪里都没有：说明没装、给出解压位置", () => {
    const install = temp();
    const local = temp();
    mkdirSync(join(install, "resources", "tts"), { recursive: true });
    writeFileSync(join(install, "resources", "tts", "runner.py"), "");
    const lookup = findTtsBundle({ execPath: join(install, "评审室.exe"), resourcesPath: join(install, "resources"), localAppData: local });
    assert.equal(lookup.bundle, null);
    assert.ok(lookup.reason?.includes("没装"));
    assert.ok(lookup.reason?.includes("tts-runtime"));
  });

  it("程序本体缺 runner.py：让人重装程序，而不是怪语音包", () => {
    const { install, ttsRoot } = fakeInstall({ withRunner: false });
    const lookup = findTtsBundle(input(install, ttsRoot));
    assert.equal(lookup.bundle, null);
    assert.ok(lookup.reason?.includes("缺少 runner.py"));
  });

  it("真实布局：语音包在 LOCALAPPDATA，runner.py 只在 resources —— 能配上，script 指向 resources", () => {
    const { install, ttsRoot } = fakeInstall();
    const lookup = findTtsBundle(input(install, ttsRoot));
    assert.ok(lookup.bundle !== null, lookup.reason ?? "");
    assert.equal(lookup.bundle.script, join(install, "resources", "tts", "runner.py"));
    assert.equal(lookup.bundle.baseDir, join(ttsRoot, "评审室", "tts"));
    assert.equal(lookup.bundle.python, join(ttsRoot, "评审室", "tts", "python", "python.exe"));
  });

  it("解压到安装目录（没有 runner.py）也认", () => {
    const { install } = fakeInstall();
    // 把语音包复制到安装目录下
    const base = join(install, "tts");
    mkdirSync(join(base, "python"), { recursive: true });
    mkdirSync(join(base, "site-packages"), { recursive: true });
    mkdirSync(join(base, "index-tts"), { recursive: true });
    mkdirSync(join(base, "models", "IndexTTS-2"), { recursive: true });
    writeFileSync(join(base, "python", "python.exe"), "");
    writeFileSync(join(base, "runtime.json"), JSON.stringify({ version: TTS_RUNTIME_VERSION }));
    writeFileSync(join(base, "models", "IndexTTS-2", "model.json"), JSON.stringify({ version: TTS_MODEL_VERSION }));
    const lookup = findTtsBundle({ execPath: join(install, "评审室.exe"), resourcesPath: join(install, "resources"), localAppData: temp() });
    assert.ok(lookup.bundle !== null, lookup.reason ?? "");
    assert.equal(lookup.bundle.baseDir, base);
  });

  it("缺一项：说清楚缺什么（并且安装目录不完整时会继续找 LOCALAPPDATA）", () => {
    const { install, ttsRoot } = fakeInstall();
    // 安装目录放一份不完整的（缺 site-packages），LOCALAPPDATA 那份完整
    const base = join(install, "tts");
    mkdirSync(join(base, "python"), { recursive: true });
    writeFileSync(join(base, "python", "python.exe"), "");
    const lookup = findTtsBundle(input(install, ttsRoot));
    assert.ok(lookup.bundle !== null, lookup.reason ?? "");
    assert.equal(lookup.bundle.baseDir, join(ttsRoot, "评审室", "tts"));

    rmSync(join(ttsRoot, "评审室", "tts", "site-packages"), { recursive: true, force: true });
    const broken = findTtsBundle(input(install, ttsRoot));
    assert.equal(broken.bundle, null);
    assert.ok(broken.reason?.includes("不完整"));
    assert.ok(broken.reason?.includes("site-packages"));
  });

  it("版本文件缺失 / 版本不对：明确提示重新解压", () => {
    const missing = fakeInstall({ skip: "runtime" });
    assert.ok(findTtsBundle(input(missing.install, missing.ttsRoot)).reason?.includes("runtime.json"));
    const wrong = fakeInstall({ model: "indextts2-0.9.0" });
    const lookup = findTtsBundle(input(wrong.install, wrong.ttsRoot));
    assert.equal(lookup.bundle, null);
    assert.ok(lookup.reason?.includes("版本不对"));
  });

  it("旧的内置布局 resources/tts 仍然兼容", () => {
    const install = temp();
    const resources = join(install, "resources", "tts");
    mkdirSync(join(resources, "python"), { recursive: true });
    mkdirSync(join(resources, "site-packages"), { recursive: true });
    mkdirSync(join(resources, "index-tts"), { recursive: true });
    mkdirSync(join(resources, "models", "IndexTTS-2"), { recursive: true });
    writeFileSync(join(resources, "runner.py"), "");
    writeFileSync(join(resources, "python", "python.exe"), "");
    writeFileSync(join(resources, "runtime.json"), JSON.stringify({ version: TTS_RUNTIME_VERSION }));
    writeFileSync(join(resources, "models", "IndexTTS-2", "model.json"), JSON.stringify({ version: TTS_MODEL_VERSION }));
    const lookup = findTtsBundle({ execPath: join(install, "评审室.exe"), resourcesPath: join(install, "resources"), localAppData: temp() });
    assert.ok(lookup.bundle !== null, lookup.reason ?? "");
    assert.equal(lookup.bundle.baseDir, resources);
  });
});
