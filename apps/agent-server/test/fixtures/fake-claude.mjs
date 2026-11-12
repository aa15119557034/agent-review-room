// 模拟 `claude -p --output-format stream-json --verbose --include-partial-messages`
// FAKE_MODE: success | truncated | error | noisy | split | slow | crash
// FAKE_RATE：5 小时窗口用了多少（0～1）；FAKE_RESET_5H：那个窗口的重置时间（Unix 秒），默认很远的将来
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
    // 重置时间默认 2100 年：节点会丢掉已经过了重置时间的窗口（C-49 / A-04），夹具不能跟着日历过期
    const reset5h = Number(process.env.FAKE_RESET_5H ?? 4102444800);
    out({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed", resetsAt: reset5h, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false,
        unifiedWindows: {
          five_hour: { utilization: Number(process.env.FAKE_RATE), resetsAt: reset5h, status: "allowed" },
          seven_day: { utilization: 0.31, resetsAt: 4102876800, status: "allowed" },
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
  if (mode === "crash") {
    // 命令行自己出错退出：stderr 上有原因，没有 result 行，退出码非 0
    process.stderr.write("Error: Invalid model name. Run --help to see valid models.\n", () => process.exit(3));
    return;
  }
  if (mode === "error") {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 529 overloaded" });
    process.exit(0);
  }
  out({ type: "result", subtype: "success", is_error: false, result: reply, total_cost_usd: 0 });
});
