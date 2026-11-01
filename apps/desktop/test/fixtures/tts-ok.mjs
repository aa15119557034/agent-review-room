// 测试用的假 python（真协议、假引擎）：收到 ready 后按行处理 synth，写一个假 wav 回去。
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
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(2044, 7)]);
    writeFileSync(request.out, wav);
    process.stdout.write(
      JSON.stringify({ type: "done", id: request.id, ms: 1, durationMs: 1200, sampleRate: 22050 }) + "\n",
    );
  }
});
