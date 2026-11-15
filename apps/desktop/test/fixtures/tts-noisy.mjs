// 测试用的假 python：带「引擎日志」的版本（#223 评审第 5 条）。
// 启动时往 stderr 吐一段含敏感内容的文字，模拟第三方引擎把正在合成的文本打到 stderr。
process.stderr.write("loading model...\n正在合成：这句是内部测试文本，不该出现在日志里\n");
import { writeFileSync } from "node:fs";

process.stdout.write(JSON.stringify({ type: "ready", engine: "indextts2", engineVersion: "fake-1", loadMs: 1 }) + "\n");

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (line === "") continue;
    const request = JSON.parse(line);
    if (request.type === "shutdown") {
      process.exit(0);
    }
    if (request.type === "unload") {
      process.stdout.write(JSON.stringify({ type: "unloaded", id: request.id }) + "\n");
      continue;
    }
    if (request.type === "synth") {
      const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(2044, 7)]);
      writeFileSync(request.out, wav);
      process.stdout.write(
        JSON.stringify({ type: "done", id: request.id, ms: 1, durationMs: 1200, sampleRate: 22050 }) + "\n",
      );
    }
  }
});
