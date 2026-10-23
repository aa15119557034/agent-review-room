import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from "electron";
import { join } from "node:path";
import { openDatabase, repairInterruptedRuns, WriteQueue } from "@room/db";
import { HttpRemoteAgentAdapter } from "@room/remote-client";
import { BatchModel, IPC_CHANNELS, toRunModel, type ControlEvent } from "@room/schemas";
import { DiscussionService } from "./discussion";
import { createDispatcher } from "./ipc";
import { migrateLegacyReviewerNode, NodeService, resolveRunTarget } from "./nodes";
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
  // 旧设置里的 Reviewer 节点 -> user-pc（幂等）：多节点有了 Token 存储，单次评审照旧
  migrateLegacyReviewerNode(db, settings);

  let discussion: DiscussionService | null = null;

  const orchestrator = new RunOrchestrator({
    db,
    queue,
    emit: broadcast,
    getRun: (runId) => db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as never,
    // 讨论室的收尾要推 message.created / turn.updated / round.updated …，交给 DiscussionService
    onDiscussionSettled: (settlement) => discussion?.settled(settlement),
    adapterFactory: async (run) => {
      // 讨论室：agent -> node -> 地址与 Token；Phase 0 的评审 Run 沿用原来的 Reviewer 设置
      const target = resolveRunTarget(db, settings, run);
      // C-40：这一项盖章时定下的模型；null / 没有 = 不传 model，用 profile 自带
      const item = db.prepare("SELECT model FROM batch_items WHERE approval_id = ?").get(run.approval_id) as
        | { model: string | null }
        | undefined;
      const model =
        item?.model === null || item?.model === undefined
          ? undefined
          : toRunModel(BatchModel.parse(JSON.parse(item.model)));
      const adapter = new HttpRemoteAgentAdapter({
        nodeId: target.nodeId,
        baseUrl: target.baseUrl,
        profileId: target.profileId,
        token: target.token,
        ...(model === undefined ? {} : { model }),
        heartbeatTimeoutMs: 15_000,
        reconnectGraceMs: 30_000,
        requestTimeoutMs: 10_000,
      });
      await adapter.initialize();
      return adapter;
    },
  });

  discussion = new DiscussionService({
    db,
    queue,
    repo,
    settings,
    orchestrator,
    emit: broadcast,
  });

  const nodes = new NodeService({ repo, settings });

  const dispatcher = createDispatcher({
    repo,
    settings,
    orchestrator,
    discussion,
    nodes,
    appVersion: app.getVersion(),
    recoveredRuns: repaired.repaired.length,
    emit: broadcast,
  });

  ipcMain.handle(IPC_CHANNELS.command, async (_event, request: unknown) => dispatcher.handleCommand(request));
  ipcMain.handle(IPC_CHANNELS.query, async (_event, request: unknown) => dispatcher.handleQuery(request));

  app.on("before-quit", () => {
    // 让节点立刻停下，而不是等租约过期（abort 由 orchestrator 统一发出）
    orchestrator.cancelAll();
    try {
      db.close();
    } catch {
      // 已经关闭
    }
  });

  createWindow();
}

void app.whenReady().then(async () => {
  try {
    await bootstrap();
  } catch (error) {
    // 迁移失败 / DB 被锁：以前这里会把 promise 丢掉，窗口不开、进程还挂着
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("启动失败", "无法初始化本地数据库或设置：\n" + message);
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
