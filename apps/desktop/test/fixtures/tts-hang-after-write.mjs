// 测试用的假 python（真协议、假引擎）：把 out 写出来之后就不再回应，模拟「写了一半卡住」。
// 主控端超时会杀进程；这个 fixture 用来验证「等进程停下来再删临时文件」。
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
    if (request.type === "synth") {
      writeFileSync(request.out, Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(1024, 1)]));
      // 故意不回 done / failed：等主控端超时
    }
  }
});

setInterval(() => {}, 1000);
