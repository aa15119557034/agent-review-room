// 测试用的假 python（真协议、假引擎）：把请求里的 out 写出来，然后报 failed。
// 用来复现林离 #163 的第 2 条：失败时临时 wav 不能留在系统临时目录。
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
    writeFileSync(request.out, Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(1024, 1)]));
    process.stdout.write(JSON.stringify({ type: "failed", id: request.id, error: "simulated failure" }) + "\n");
  }
});
