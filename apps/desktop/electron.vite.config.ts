import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const root=resolve(__dirname,"../..");
const revision=process.env["ROOM_BUILD_SHA"]??execFileSync("git",["-c","safe.directory="+root,"rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim();
const dirty=execFileSync("git",["-c","safe.directory="+root,"status","--porcelain"],{cwd:root,encoding:"utf8"}).trim().length>0;
const version=(JSON.parse(readFileSync(resolve(__dirname,"package.json"),"utf8")) as {version:string}).version;
export default defineConfig({
  main: {
    define: { "process.env.ROOM_BUILD_SHA": JSON.stringify(revision) },
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES }), { name:"room-build-info", generateBundle(){this.emitFile({type:"asset",fileName:"build-info.json",source:JSON.stringify({version,revision,dirty},null,2)});}}],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })],
  },
  renderer: {
    plugins: [react()],
  },
});
