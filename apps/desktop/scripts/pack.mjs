import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * 打包桌面端（D-39b 后续：Python + IndexTTS2 模型进安装包）。
 *
 * 产物（都放 release/）：
 *   安装包 exe（只装程序本体，200~400MB）
 *   tts-runtime-<版本>.zip    Python + site-packages + IndexTTS2 代码（约 7GB）
 *   tts-model-IndexTTS-2.zip  模型（约 10.6GB）
 *
 * 用户把两个 zip 解压到安装目录，得到 <安装目录>/tts/...，程序启动时自动用。
 *
 * 用法：
 *   node scripts/pack.mjs             # 先出两个语音包 zip，再出 NSIS 安装包
 *   node scripts/pack.mjs --dir       # 只出免安装目录（win-unpacked），验证布局用
 *
 * 源目录默认 E:\AI\TTS，可以用 TTS_BUNDLE_DIR 覆盖。四样东西必须都在：
 *   pythons/cpython-3.11.13-windows-x86_64-none   base Python
 *   index-tts/.venv/Lib/site-packages             torch 等依赖
 *   index-tts                                     代码（不含 .venv）
 *   models/IndexTTS-2                             权重
 */
const desktop = process.cwd();
const RUNTIME_VERSION = "1";
const MODEL_VERSION = "indextts2-2.0.0";

function find7za() {
  const local = join(desktop, "..", "..", "node_modules", "7zip-bin", "win", "x64", "7za.exe");
  if (existsSync(local)) return local;
  const cache = join(process.env.LOCALAPPDATA ?? "", "electron-builder", "Cache", "7zip@1.0.0", "7zip-win-x64-a34pt", "bin", "7za.exe");
  if (existsSync(cache)) return cache;
  console.error("[pack] 找不到 7za.exe（装 electron-builder 时会带 7zip-bin）");
  process.exit(1);
}

if (!process.argv.includes("--app-only")) {
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

// 语音包：拆成 runtime（Python + 依赖 + 代码，约 7GB）和 model（约 10.6GB）两个 zip。
// 解压到安装目录后是 <安装目录>/tts/...；安装包本身只带 runner.py。
const release = join(desktop, "..", "..", "release");
const runtimeStage = join(desktop, "vendor", "zip-runtime");
const modelStage = join(desktop, "vendor", "zip-model");
rmSync(runtimeStage, { recursive: true, force: true });
rmSync(modelStage, { recursive: true, force: true });
mkdirSync(join(runtimeStage, "tts"), { recursive: true });
mkdirSync(join(modelStage, "tts", "models"), { recursive: true });

console.log("[pack] 暂存语音包（约 18GB，第一次会慢）");
cpSync(join(source, "pythons", "cpython-3.11.13-windows-x86_64-none"), join(runtimeStage, "tts", "python"), {
  recursive: true,
});
cpSync(join(source, "index-tts", ".venv", "Lib", "site-packages"), join(runtimeStage, "tts", "site-packages"), {
  recursive: true,
});
cpSync(join(source, "index-tts"), join(runtimeStage, "tts", "index-tts"), {
  recursive: true,
  filter: (path) => !path.includes(join("index-tts", ".venv")),
});
writeFileSync(join(runtimeStage, "tts", "runtime.json"), JSON.stringify({ version: RUNTIME_VERSION }) + "\n");
cpSync(join(source, "models", "IndexTTS-2"), join(modelStage, "tts", "models", "IndexTTS-2"), { recursive: true });
writeFileSync(
  join(modelStage, "tts", "models", "IndexTTS-2", "model.json"),
  JSON.stringify({ version: MODEL_VERSION }) + "\n",
);

// 7z 的 zip 写入在超过 4GB 时自动用 zip64；Windows 自带解压和 7-Zip 都能读
const sevenZip = find7za();
function zip(stageDir, fileName) {
  mkdirSync(release, { recursive: true });
  const out = join(release, fileName);
  rmSync(out, { force: true });
  console.log("[pack] 打语音包 " + fileName + "（zip / 不压缩存储，最快；zip64 由 7z 自动处理）");
  const result = spawnSync(sevenZip, ["a", "-tzip", "-mx=0", out, "."], {
    cwd: stageDir,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
zip(runtimeStage, "tts-runtime-" + RUNTIME_VERSION + ".zip");
zip(modelStage, "tts-model-IndexTTS-2.zip");
console.log("[pack] 语音包已输出到 " + release);
}


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
