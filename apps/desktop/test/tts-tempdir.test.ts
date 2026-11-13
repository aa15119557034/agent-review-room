import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { TtsRunner, type TtsConfig } from "../src/main/tts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 句柄延迟
    }
  }
});

describe("tts 临时文件清理（#218 评审 3）", () => {
  it("清理的是 tempDir 里的旧 wav，不是 tmpdir()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "room-tts-temp-"));
    dirs.push(dir);
    const tempDir = join(dir, "tmp");
    mkdirSync(tempDir);
    writeFileSync(join(dir, "python.exe"), "");
    writeFileSync(join(dir, "runner.py"), "");
    const stale = join(tempDir, `room-tts-${process.pid}-old.wav`);
    writeFileSync(stale, "old");
    const config: TtsConfig = {
      engine: "indextts2",
      engineVersion: "test",
      python: join(dir, "python.exe"),
      script: join(dir, "runner.py"),
      modelDir: dir,
      voices: [{ id: "xiaoyu" as never, displayName: "小雨", source: "reference", refAudio: join(dir, "ref.wav") }],
      tempDir,
    };
    const runner = new TtsRunner(config);
    await assert.rejects(runner.synthesize({ text: "测试", voice: config.voices[0]!, speed: 1, signal: AbortSignal.timeout(20_000) }));
    assert.equal(existsSync(stale), false, "tempDir 里的旧临时文件应该被清掉");
  });
});
