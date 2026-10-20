import { app, BrowserWindow, ipcMain, nativeTheme, safeStorage, shell } from "electron";
import { join } from "node:path";
import { openDatabase, repairInterruptedRuns, WriteQueue } from "@room/db";
import { HttpRemoteAgentAdapter } from "@room/remote-client";
import { IPC_CHANNELS, type ControlEvent } from "@room/schemas";
import { createDispatcher } from "./ipc";
import { RunOrchestrator } from "./orchestrator";
import { Repository } from "./repository";
import { SettingsStore } from "./settings";

/**
 * Electron 主进程入口（D-07）。
 *
 * 启动顺序对齐 V0.4 §32：初始化 DB → 修复中断的 run → 起 IPC → 开窗口。
 * Token 只在主进程解密使用，绝不进 renderer / SQLite / 日志。
 */

const isDev = !app.isPackaged;

function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#131b1f" : "#e9eeec";
}

let mainWindow: BrowserWindow | null = null;

function broadcast(event: ControlEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC_CHANNELS.event, event);
  }
}

function createWindow(): void {
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "Agent 评审室",
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = window;
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const allowed = devServerUrl !== undefined ? url.startsWith(devServerUrl) : url.startsWith("file://");
    if (!allowed) event.preventDefault();
  });

  if (isDev && devServerUrl !== undefined) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath("userData");
  const db = openDatabase(join(userData, "room.db"));
  const queue = new WriteQueue();
  const repo = new Repository(db, queue);

  // §32 第 3 步：上次崩溃留下的 QUEUED / STARTING / RUNNING 统一标成 interrupted
  const repaired = await repairInterruptedRuns(db, queue);

  const settings = new SettingsStore(join(userData, "settings.json"), safeStorage);

  const orchestrator = new RunOrchestrator({
    db,
    queue,
    emit: broadcast,
    getRun: (runId) => db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as never,
    adapterFactory: async () => {
      const node = settings.get();
      const token = settings.getToken();
      if (node === null || token === null) throw new Error("reviewer node is not configured");
      const adapter = new HttpRemoteAgentAdapter({
        nodeId: "review-node",
        baseUrl: node.baseUrl,
        profileId: node.profileId,
        token,
        heartbeatTimeoutMs: 15_000,
        reconnectGraceMs: 30_000,
        requestTimeoutMs: 10_000,
      });
      await adapter.initialize();
      return adapter;
    },
  });

  const dispatcher = createDispatcher({
    repo,
    settings,
    orchestrator,
    appVersion: app.getVersion(),
    recoveredRuns: repaired.repaired.length,
    emit: broadcast,
  });

  ipcMain.handle(IPC_CHANNELS.command, async (_event, request: unknown) => dispatcher.handleCommand(request));
  ipcMain.handle(IPC_CHANNELS.query, async (_event, request: unknown) => dispatcher.handleQuery(request));

  app.on("before-quit", () => {
    try {
      db.close();
    } catch {
      // 已经关闭
    }
  });

  createWindow();
}

void app.whenReady().then(async () => {
  await bootstrap();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
