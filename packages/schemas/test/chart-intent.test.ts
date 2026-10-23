import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AgentReplyEnvelope,
  CHART_LIMITS,
  COMMANDS,
  DEFAULT_IMMERSIVE_SETTINGS,
  ImmersiveSettings,
  extractMediaIntent,
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
  });
});

describe("media intent & immersive (C-42d)", () => {
  it("envelope: skip with media fields is a parse failure; reply needs text", () => {
    assert.ok(AgentReplyEnvelope.safeParse({ kind: "skip" }).success);
    assert.equal(AgentReplyEnvelope.safeParse({ kind: "skip", draw: { prompt: "x", size: "1024x1024" } }).success, false);
    assert.equal(AgentReplyEnvelope.safeParse({ kind: "skip", speak: true }).success, false);
    assert.equal(AgentReplyEnvelope.safeParse({ kind: "reply", text: "  " }).success, false);
    assert.equal(AgentReplyEnvelope.safeParse({ kind: "reply", text: "好", tool: "rm" }).success, false);
  });

  it("valid envelope with bad media fields keeps the text and drops the intent", () => {
    const ok = AgentReplyEnvelope.parse({ kind: "reply", text: "给你画", draw: { prompt: "小鲸鱼", size: "1024x1024" }, speak: true });
    assert.deepEqual(extractMediaIntent(ok as never), { intent: { speak: true, draw: { prompt: "小鲸鱼", size: "1024x1024" } }, dropped: false });
    const plain = AgentReplyEnvelope.parse({ kind: "reply", text: "好" });
    assert.deepEqual(extractMediaIntent(plain as never), { intent: null, dropped: false });
    for (const media of [
      { draw: { prompt: "x", size: "8192x8192" } },
      { draw: { prompt: "x".repeat(1001), size: "1024x1024" } },
      { draw: { prompt: "x", size: "1024x1024", backend: "codex" } },
      { speak: "yes" },
      { speak: false },
    ]) {
      const env = AgentReplyEnvelope.parse({ kind: "reply", text: "好", ...media });
      assert.deepEqual(extractMediaIntent(env as never), { intent: null, dropped: true }, JSON.stringify(media));
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
