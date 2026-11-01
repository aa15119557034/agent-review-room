// 模拟 `claude -p --output-format stream-json --verbose --include-partial-messages`
// FAKE_MODE: success | truncated | error | noisy | split
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  const mode = process.env.FAKE_MODE ?? "success";
  const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  const delta = (text, extra = {}) =>
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, parent_tool_use_id: null, ...extra });

  out({ type: "system", subtype: "init", model: "claude-test", session_id: "s1" });
  // S-21：claude 2.1.x 顺带输出的额度（形状照 2026-11-01 实测）
  if (process.env.FAKE_RATE) {
    out({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed", resetsAt: 1793577600, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false,
        unifiedWindows: {
          five_hour: { utilization: Number(process.env.FAKE_RATE), resetsAt: 1793577600, status: "allowed" },
          seven_day: { utilization: 0.31, resetsAt: 1793962800, status: "allowed" },
        },
      },
      uuid: "u1", session_id: "s1",
    });
  }
  if (mode === "slow") {
    const n = Number(process.env.FAKE_CHUNKS ?? 15);
    let all = "";
    for (let i = 0; i < n; i++) {
      const t = `第${i}段；`;
      all += t;
      delta(t);
      await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DELAY_MS ?? 100)));
    }
    out({ type: "result", subtype: "success", is_error: false, result: all });
    return;
  }
  if (mode === "noisy") process.stdout.write("Warning: something non-json\n");

  const reply = `收到 ${input.length} 个字符。风险😀：并发写入。`;
  const parts = [...reply];
  const half = Math.floor(parts.length / 2);
  const a = parts.slice(0, half).join("");
  const b = parts.slice(half).join("");

  if (mode === "split") {
    // 一行 JSON 分成两次写，中间隔一会儿：解析器必须按行缓冲
    const line = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: a } }, parent_tool_use_id: null }) + "\n";
    process.stdout.write(line.slice(0, 25));
    await new Promise((r) => setTimeout(r, 50));
    process.stdout.write(line.slice(25));
  } else {
    delta(a);
  }
  // 子 agent 的文字不应算进 Reviewer 的回复
  delta("[子任务内部文字]", { parent_tool_use_id: "toolu_1" });
  delta(b);
  out({ type: "assistant", message: { content: [{ type: "text", text: reply }] } });

  if (mode === "truncated") process.exit(0); // 没有 result 行，但退出码 0
  if (mode === "error") {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 529 overloaded" });
    process.exit(0);
  }
  out({ type: "result", subtype: "success", is_error: false, result: reply, total_cost_usd: 0 });
});
