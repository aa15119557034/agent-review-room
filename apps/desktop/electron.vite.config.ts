import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * electron-vite 约定目录：
 *   src/main/index.ts     → out/main/index.js
 *   src/preload/index.ts  → out/preload/index.js
 *   src/renderer/index.html → out/renderer/
 * 主进程/preload 的依赖用 externalizeDepsPlugin 外置（node_modules 里原生模块不能被 bundle）。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
});
