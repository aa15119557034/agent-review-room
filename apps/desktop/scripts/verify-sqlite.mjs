import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * verify:sqlite 的启动器。
 *
 * 直接写 "electron xxx" 在某些环境里会退化成普通 Node 进程：
 * 只要继承到 ELECTRON_RUN_AS_NODE=1（从 Electron 应用派生的终端就是这样），
 * electron 就会以 Node 模式启动，require("electron") 拿不到 app。
 * 这里先把这个变量摘掉，保证跑的是真正的 Electron 主进程。
 */
const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const smokeScript = fileURLToPath(new URL("./sqlite-smoke.cjs", import.meta.url));

const env = { ...process.env };
delete env["ELECTRON_RUN_AS_NODE"];

const child = spawn(electronBinary, [smokeScript], { stdio: "inherit", env });
child.on("exit", (code, signal) => {
  if (signal !== null) {
    console.error("smoke test killed by signal:", signal);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
