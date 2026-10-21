// 模拟 `codex exec --json -`（事件格式见官方文档 non-interactive mode）
// FAKE_MODE: success | quota | truncated | retry_then_success
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const mode = process.env.FAKE_MODE ?? "success";
  const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  process.stderr.write("codex progress on stderr\n");
  out({ type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" });
  out({ type: "turn.started" });
  if (mode === "quota") {
    out({ type: "error", message: "You've hit your usage limit. Try again later." });
    out({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } });
    process.exit(1);
  }
  if (mode === "retry_then_success") out({ type: "error", message: "Reconnecting... 1/5" });
  out({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "思考过程不算回答" } });
  out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "先看一下材料。" } });
  if (mode === "truncated") process.exit(0);
  out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: `收到 ${input.length} 个字符。结论：同意😀` } });
  out({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
});
