import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * electron-vite 约定目录：
 *   src/main/index.ts     → out/main/index.js
 *   src/preload/index.ts  → out/preload/index.js
 *   src/renderer/index.html → out/renderer/
 *
 * workspace 包（@room/*）导出的是 TS 源码，运行时 Node 直接 require 会挂（找不到 .ts）。
 * 所以把它们**排除**在外置之外，让 Vite 打进 bundle；
 * 原生模块（better-sqlite3）仍然外置——它不能被 bundle。
 */
const WORKSPACE_PACKAGES = ["@room/core", "@room/db", "@room/schemas", "@room/remote-client", "@room/reviewer-client"];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
  },
  renderer: {
    plugins: [react()],
  },
});
