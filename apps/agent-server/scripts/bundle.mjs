// S-20：把节点打成一个不依赖 node_modules 的 .mjs，安装脚本只复制这个文件。
// node_modules 里是 pnpm 的链接（Windows 上是 junction），复制到 <AgentRoom>\node\app 会和「AgentRoom 里不能有链接」冲突。
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [join(appDir, "src", "main.ts")],
  outfile: join(appDir, "dist", "agent-server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // 打进来的 CommonJS 依赖里可能有 require：给 ESM 输出补一个
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  logLevel: "info",
});
