import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { describeUnparsableLine, forwardEngineOutput, summarizeEngineChunk, TtsRunner, type TtsConfig } from "../src/main/tts";

/**
 * #223 评审第 5 条：C-51 之后 console 会抄一份进 `<数据目录>/logs/main.log`，
 * 而崩溃 / 启动失败对话框正好请用户「把日志文件发给开发者」。
 * 所以语音引擎（第三方）的 stderr 默认不能进日志，只记行数和字节数。
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
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
  const dir = mkdtempSync(join(tmpdir(), "room-tts-log-"));
  dirs.push(dir);
  return dir;
}

const voice = { id: "xiaoyu", displayName: "小雨", source: "reference", refAudio: "ref.wav" } as const;

function config(script: string, tempDir: string): TtsConfig {
  return {
    engine: "indextts2",
    engineVersion: "fake-1",
    // 用 node 冒充 python：spawn(execPath, [script]) 一样是「起一个子进程说行协议」
    python: process.execPath,
    script: join(fixtures, script),
    modelDir: fixtures,
    voices: [voice],
    tempDir,
  };
}

/** 抓 console.warn（TtsRunner 只用 warn 记引擎输出） */
async function captureWarn(run: () => Promise<void>): Promise<string> {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    seen.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
  };
  try {
    await run();
    // stderr 是另外一路 pipe，给它一点时间送到
    await new Promise((resolve) => setTimeout(resolve, 150));
  } finally {
    console.warn = original;
  }
  return seen.join("\n");
}

async function synthOnce(script: string): Promise<string> {
  const tempDir = temp();
  const runner = new TtsRunner(config(script, tempDir));
  try {
    return await captureWarn(async () => {
      await runner.synthesize({ text: "你好", voice: voice as never, speed: 1, signal: new AbortController().signal });
    });
  } finally {
    runner.dispose();
  }
}

describe("引擎日志不进日志文件（#223 评审第 5 条）", () => {
  it("默认只记行数和字节数，引擎原话（可能含合成文本）不出现", async () => {
    const text = await synthOnce("tts-noisy.mjs");
    assert.match(text, /\[tts\] 引擎日志 2 行 \/ \d+ 字节/, text);
    assert.doesNotMatch(text, /内部测试文本/, text);
    assert.doesNotMatch(text, /loading model/, text);
  });

  it("ROOM_TTS_DEBUG=1 才原样转发（排查用）", async () => {
    const previous = process.env["ROOM_TTS_DEBUG"];
    process.env["ROOM_TTS_DEBUG"] = "1";
    try {
      const text = await synthOnce("tts-noisy.mjs");
      assert.match(text, /内部测试文本/, text);
      assert.match(text, /loading model/, text);
    } finally {
      if (previous === undefined) delete process.env["ROOM_TTS_DEBUG"];
      else process.env["ROOM_TTS_DEBUG"] = previous;
    }
  });
});

describe("引擎日志摘要的工具函数", () => {
  it("空行不算行，字节数按 UTF-8 算", () => {
    assert.deepEqual(summarizeEngineChunk("a\n\nb\r\n  \n"), { lines: 2, bytes: Buffer.byteLength("a\n\nb\r\n  \n", "utf8") });
    assert.deepEqual(summarizeEngineChunk(""), { lines: 0, bytes: 0 });
    assert.deepEqual(summarizeEngineChunk("中文一行\n"), { lines: 1, bytes: Buffer.byteLength("中文一行\n", "utf8") });
  });

  it("调试开关只认 \"1\"", () => {
    assert.equal(forwardEngineOutput("1"), true);
    for (const flag of [undefined, "", "0", "true", "yes"]) assert.equal(forwardEngineOutput(flag), false);
  });

  it("解析失败的行：默认只说长度，调试时给前 200 字", () => {
    const line = "x".repeat(500);
    const quiet = describeUnparsableLine(undefined, line);
    assert.match(quiet, /^500 字/);
    assert.doesNotMatch(quiet, /xxxx/);
    const loud = describeUnparsableLine("1", line);
    assert.match(loud, /^500 字：/);
    assert.ok(loud.includes("x".repeat(200)));
    assert.ok(!loud.includes("x".repeat(201)));
  });
});
