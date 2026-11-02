import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * 打包桌面端（D-39b 后续：Python + IndexTTS2 模型进安装包）。
 *
 * 用法：
 *   node scripts/pack.mjs             # 完整 NSIS 安装包（约 18GB，慢）
 *   node scripts/pack.mjs --dir       # 只出免安装目录（win-unpacked），验证布局用
 *
 * 源目录默认 E:\AI\TTS，可以用 TTS_BUNDLE_DIR 覆盖。四样东西必须都在：
 *   pythons/cpython-3.11.13-windows-x86_64-none   base Python
 *   index-tts/.venv/Lib/site-packages             torch 等依赖
 *   index-tts                                     代码（不含 .venv）
 *   models/IndexTTS-2                             权重
 */
const desktop = process.cwd();
const source = process.env.TTS_BUNDLE_DIR ?? "E:\\AI\\TTS";
const required = [
  join(source, "pythons", "cpython-3.11.13-windows-x86_64-none", "python.exe"),
  join(source, "index-tts", ".venv", "Lib", "site-packages"),
  join(source, "index-tts"),
  join(source, "models", "IndexTTS-2"),
];
const missing = required.filter((path) => !existsSync(path));
if (missing.length > 0) {
  console.error("[pack] 缺少语音合成资源：");
  for (const path of missing) console.error("  - " + path);
  console.error("用 TTS_BUNDLE_DIR 指到正确的目录（默认 E:\\AI\\TTS）");
  process.exit(1);
}
console.log("[pack] 资源源目录：" + source);

// 先暂存到 vendor/tts（electron-builder 的 from 用相对路径更稳，Windows 盘符 + 环境变量宏会被当成相对路径）
const stage = join(desktop, "vendor", "tts");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "models"), { recursive: true });
console.log("[pack] 暂存 Python / 依赖 / 代码 / 模型到 " + stage + "（约 18GB，第一次会慢）");
cpSync(join(source, "pythons", "cpython-3.11.13-windows-x86_64-none"), join(stage, "python"), { recursive: true });
cpSync(join(source, "index-tts", ".venv", "Lib", "site-packages"), join(stage, "site-packages"), { recursive: true });
cpSync(join(source, "index-tts"), join(stage, "index-tts"), {
  recursive: true,
  filter: (path) => !path.includes(join("index-tts", ".venv")),
});
cpSync(join(source, "models", "IndexTTS-2"), join(stage, "models", "IndexTTS-2"), { recursive: true });
console.log("[pack] 暂存完成，开始打包");

function run(args, extraEnv = {}) {
  const result = spawnSync(args[0] === "pnpm" ? "pnpm.cmd" : args[0], args.slice(1), {
    cwd: desktop,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// better-sqlite3 v13 自带 Node-API prebuilds（win32-x64 在 prebuilds/ 里），Electron 直接能加载，
// 所以不跑 electron-rebuild（本机也没装 VS Build Tools）。electron-builder.yml 里 npmRebuild: false。
run(["pnpm", "exec", "electron-vite", "build"]);
run(["pnpm", "exec", "electron-builder", ...(process.argv.includes("--dir") ? ["--dir"] : [])]);
