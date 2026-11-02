import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { bundledTtsConfig, bundledTtsPaths } from "../src/main/tts-paths";

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

function resources(marker: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "room-tts-"));
  dirs.push(dir);
  if (!marker) return dir;
  const base = join(dir, "tts");
  mkdirSync(join(base, "python"), { recursive: true });
  mkdirSync(join(base, "site-packages"), { recursive: true });
  mkdirSync(join(base, "index-tts"), { recursive: true });
  mkdirSync(join(base, "models", "IndexTTS-2"), { recursive: true });
  writeFileSync(join(base, "python", "python.exe"), "");
  writeFileSync(join(base, "runner.py"), "");
  return dir;
}

describe("bundled tts paths", () => {
  it("安装包里缺任何一项都返回 null", () => {
    assert.equal(bundledTtsPaths(resources(false)), null);
  });

  it("四项都在时给出 python / 脚本 / 模型 / 代码 / site-packages", () => {
    const paths = bundledTtsPaths(resources(true));
    assert.ok(paths !== null);
    assert.ok(paths.python.endsWith(join("python", "python.exe")));
    assert.ok(paths.script.endsWith("runner.py"));
    assert.ok(paths.modelDir.endsWith(join("models", "IndexTTS-2")));
    assert.ok(paths.root.endsWith("index-tts"));
    assert.ok(paths.sitePackages.endsWith("site-packages"));
  });

  it("bundledTtsConfig 保留用户配置里的 voices", () => {
    const dir = resources(true);
    const config = bundledTtsConfig(dir, [
      { id: "voice_01" as never, displayName: "默认", source: "reference", refAudio: "a.wav" },
    ]);
    assert.ok(config !== null);
    assert.equal(config.engine, "indextts2");
    assert.equal(config.voices.length, 1);
    assert.equal(config.sitePackages, join(dir, "tts", "site-packages"));
  });
});
