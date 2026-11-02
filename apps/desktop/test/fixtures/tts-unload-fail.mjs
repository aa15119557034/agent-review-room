// 测试用的假 python：unload 回 failed（模拟 CUDA 释放出错），其余照常合成。
// 主控端收到 failed 会杀掉这个进程（进程退出才一定放出显存），下一次合成要重新起。
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
      process.stdout.write(
        JSON.stringify({ type: "failed", id: request.id, error: "model_release_failed: CUDA error" }) + "\n",
      );
      continue;
    }
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(2044, 7)]);
    writeFileSync(request.out, wav);
    process.stdout.write(
      JSON.stringify({ type: "done", id: request.id, ms: 1, durationMs: 1200, sampleRate: 22050 }) + "\n",
    );
  }
});
