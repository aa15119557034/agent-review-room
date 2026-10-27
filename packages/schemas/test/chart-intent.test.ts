import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ChatAgentOutput,
  CHART_LIMITS,
  COMMANDS,
  DEFAULT_IMMERSIVE_SETTINGS,
  ImmersiveSettings,
  extractMediaIntent,
  SPEAK_MAX_CHARS,
  speakableText,
  parseChartSpec,
} from "../src/index";

const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const bar = { type: "bar", title: "三位的回答时长", categories: ["C酱", "汐", "林离"], series: [{ name: "秒", values: [12, 8, null] }] };

describe("chart (C-42d)", () => {
  it("accepts each chart type", () => {
    assert.ok(parseChartSpec(JSON.stringify(bar)).ok);
    assert.ok(parseChartSpec(JSON.stringify({ ...bar, type: "line" })).ok);
    assert.ok(parseChartSpec(JSON.stringify({ type: "scatter", series: [{ name: "a", points: [{ x: 1, y: 2 }] }] })).ok);
    assert.ok(parseChartSpec(JSON.stringify({ type: "pie", slices: [{ label: "同意", value: 2 }, { label: "反对", value: 1 }] })).ok);
    assert.ok(parseChartSpec(JSON.stringify({ type: "table", columns: ["人", "票"], rows: [["汐", 1], ["林离", null]] })).ok);
  });

  it("rejects extra fields, html-ish hooks, shape mismatches and oversize input", () => {
    const bad = [
      { ...bar, onClick: "alert(1)" },
      { ...bar, series: [{ name: "秒", values: [1, 2, 3], formatter: "x=>x" }] },
      { ...bar, series: [{ name: "秒", values: [1, 2] }] },
      { type: "pie", xLabel: "饼图没有坐标轴", slices: [{ label: "a", value: 1 }] },
      { type: "pie", slices: [{ label: "a", value: -1 }] },
      { type: "table", columns: ["a", "b"], rows: [["only one"]] },
      { ...bar, title: "x".repeat(CHART_LIMITS.titleMaxChars + 1) },
      { type: "svg", content: "<svg/>" },
    ];
    for (const b of bad) assert.equal(parseChartSpec(JSON.stringify(b)).ok, false, JSON.stringify(b).slice(0, 60));
    const many = { type: "bar", categories: Array.from({ length: 100 }, (_, i) => `c${i}`), series: Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, values: Array(100).fill(1) })) };
    assert.deepEqual(parseChartSpec(JSON.stringify(many)), { ok: false, reason: "invalid" }, "600 points > 500");
    assert.deepEqual(parseChartSpec("{"), { ok: false, reason: "not_json" });
    assert.deepEqual(parseChartSpec(" ".repeat(CHART_LIMITS.maxJsonBytes + 1)), { ok: false, reason: "too_large" });
    assert.deepEqual(parseChartSpec("[[[[[[[[1]]]]]]]]"), { ok: false, reason: "too_deep" });
    const deep = "[".repeat(30_000) + "]".repeat(30_000);
    assert.ok(deep.length < CHART_LIMITS.maxJsonBytes);
    assert.deepEqual(parseChartSpec(deep), { ok: false, reason: "too_deep" }, "no stack overflow");
  });
});

describe("media intent & immersive (C-42d)", () => {
  it("envelope: skip with media fields is a parse failure; reply needs text", () => {
    assert.ok(ChatAgentOutput.safeParse({ kind: "skip" }).success);
    assert.equal(ChatAgentOutput.safeParse({ kind: "skip", draw: { prompt: "x", size: "1024x1024" } }).success, false);
    assert.equal(ChatAgentOutput.safeParse({ kind: "skip", speak: true }).success, false);
    assert.equal(ChatAgentOutput.safeParse({ kind: "reply", text: "  " }).success, false);
    assert.equal(ChatAgentOutput.safeParse({ kind: "reply", text: "好", tool: "rm" }).success, false);
  });

  it("valid envelope with bad media fields keeps the text and drops only the bad field", () => {
    const ok = ChatAgentOutput.parse({ kind: "reply", text: "给你画", draw: { prompt: "小鲸鱼", size: "1024x1024" }, speak: true });
    assert.deepEqual(extractMediaIntent(ok as never), { intent: { speak: true, draw: { prompt: "小鲸鱼", size: "1024x1024" } }, dropped: false });
    const plain = ChatAgentOutput.parse({ kind: "reply", text: "好" });
    assert.deepEqual(extractMediaIntent(plain as never), { intent: null, dropped: false });
    for (const media of [
      { draw: { prompt: "x", size: "8192x8192" } },
      { draw: { prompt: "x".repeat(1001), size: "1024x1024" } },
      { draw: { prompt: "x", size: "1024x1024", backend: "codex" } },
      { speak: "yes" },
    ]) {
      const env = ChatAgentOutput.parse({ kind: "reply", text: "好", ...media });
      assert.deepEqual(extractMediaIntent(env as never), { intent: null, dropped: true }, JSON.stringify(media));
    }
    const env = (media: object) => ChatAgentOutput.parse({ kind: "reply", text: "好", ...media }) as never;
    const d = { prompt: "小鲸鱼", size: "1024x1024" };
    assert.deepEqual(extractMediaIntent(env({ speak: false })), { intent: null, dropped: false }, "speak: false = not set");
    assert.deepEqual(extractMediaIntent(env({ speak: false, draw: d })), { intent: { draw: d }, dropped: false });
    assert.deepEqual(extractMediaIntent(env({ speak: "yes", draw: d })), { intent: { draw: d }, dropped: true }, "keep the good draw");
    assert.deepEqual(
      extractMediaIntent(env({ speak: true, draw: { ...d, size: "8192x8192" } })),
      { intent: { speak: true }, dropped: true },
      "keep the good speak",
    );
  });

  it("speak only counts for a speakable text of 1..SPEAK_MAX_CHARS chars, by the same speakableText speech uses", () => {
    const d = { prompt: "小鲸鱼", size: "1024x1024" };
    const reply = (text: string) => ChatAgentOutput.parse({ kind: "reply", text, speak: true, draw: d }) as never;
    const said = "说".repeat(SPEAK_MAX_CHARS);
    assert.deepEqual(extractMediaIntent(reply(said)), { intent: { speak: true, draw: d }, dropped: false });
    assert.deepEqual(extractMediaIntent(reply(said + "多")), { intent: { draw: d }, dropped: true }, "too long: keep only draw");
    // 原文 2500 多字，其中代码块 600 字：过滤后在上限内，照样能说（林离的例子）
    const withCode = "说".repeat(1900) + "\n```ts\n" + "x".repeat(600) + "\n```\n";
    assert.ok(withCode.length > SPEAK_MAX_CHARS);
    assert.deepEqual(extractMediaIntent(reply(withCode)), { intent: { speak: true, draw: d }, dropped: false });
    assert.deepEqual(extractMediaIntent(reply("```\ncode only\n```")), { intent: { draw: d }, dropped: true }, "nothing left to read aloud");
    // 判 speak 和合成用的是同一个函数：结果和直接拿 speakableText 量出来的一致
    for (const text of [said, said + "多", withCode, "看 https://example.com 🎉 [表情：比心]"]) {
      const n = speakableText(text).length;
      assert.equal(extractMediaIntent(reply(text)).intent?.speak === true, n > 0 && n <= SPEAK_MAX_CHARS, text.slice(0, 20));
    }
  });

  it("speakableText keeps only the spoken part", () => {
    assert.equal(speakableText("先看图：\n\n```room-chart\n{\"type\":\"bar\"}\n```\n\n汐开的最多。"), "先看图：\n汐开的最多。");
    assert.equal(speakableText("详见[这份文档](https://example.com/a)，或者 https://x.dev/b 。"), "详见这份文档，或者 。");
    assert.equal(speakableText("![图](https://example.com/a.png)好的 👍🏻 [表情：比心]"), "好的");
    assert.equal(speakableText("改 `extractMediaIntent` 就行"), "改 extractMediaIntent 就行");
    assert.equal(speakableText("没闭合的\n```\nconst a = 1"), "没闭合的");
    assert.equal(speakableText("  \n "), "");
    assert.equal(speakableText("你看[图 3：截图.png]这里 🇨🇳 1️⃣"), "你看这里 1");
    // 「[我画的图：提示词]」提示词最长 DRAW_PROMPT_MAX_CHARS（1000）：整段占位都不念（汐 #113）
    assert.equal(speakableText(`画好了[我画的图：${"鲸".repeat(1000)}]`), "画好了");
  });

  it("speakableText stays linear on a 200k reply full of unmatched brackets", () => {
    for (const junk of ["[", "![", "[表情"]) {
      const text = junk.repeat(Math.floor(200_000 / junk.length));
      const t0 = performance.now();
      speakableText(text);
      const ms = performance.now() - t0;
      assert.ok(ms < 3000, `${junk}: ${Math.round(ms)} ms`);
    }
  });

  it("immersive settings: off by default, caps can only go down", () => {
    assert.equal(DEFAULT_IMMERSIVE_SETTINGS.enabled, false);
    assert.ok(ImmersiveSettings.safeParse(DEFAULT_IMMERSIVE_SETTINGS).success);
    assert.equal(ImmersiveSettings.safeParse({ ...DEFAULT_IMMERSIVE_SETTINGS, drawsPerHour: 7 }).success, false);
    assert.equal(ImmersiveSettings.safeParse({ ...DEFAULT_IMMERSIVE_SETTINGS, voiceClipsPerHour: 31 }).success, false);
    assert.ok(COMMANDS["immersive.update"].request.safeParse({ type: "immersive.update", conversationId: `conv_${ID}`, settings: DEFAULT_IMMERSIVE_SETTINGS }).success);
  });
});
