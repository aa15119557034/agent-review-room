import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, safeStorage, shell } from "electron";
import { join } from "node:path";
import { openDatabase, repairInterruptedRuns, WriteQueue } from "@room/db";
import { HttpRemoteAgentAdapter } from "@room/remote-client";
import { IMAGE_URL_SCHEME, IPC_CHANNELS, type ControlEvent } from "@room/schemas";
import { ChatService } from "./chat";
import { DiscussionService } from "./discussion";
import { createDispatcher } from "./ipc";
import { ComfyUiClient, loadComfyUiConfigFile } from "./comfyui";
import { MediaService } from "./media";
import { MediaJobsService } from "./media-jobs";
import { createImageProtocolHandler, MediaStore } from "./media-store";
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

// D-36b：room-image:// 必须在 app ready 之前登记；只读、不导航、不当页面打开
protocol.registerSchemesAsPrivileged([
  {
    scheme: IMAGE_URL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

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

  // D-36b：图片本体和引用表；renderer 用 room-image://<ref> 显示，main 只按记录映射到文件
  const mediaStore = new MediaStore(join(userData, "images"), join(userData, "files"), db);
  protocol.handle(IMAGE_URL_SCHEME, createImageProtocolHandler(mediaStore));
  // D-34a：选文件 / 表情用的对话框。renderer 只拿 ref，拿不到路径
  const comfyConfig = loadComfyUiConfigFile(join(userData, "comfyui.json"));
  if (comfyConfig === null) console.warn("[comfyui] 没有配置 userData/comfyui.json，本机画图不可用");
  const comfyClient = comfyConfig === null ? null : new ComfyUiClient(comfyConfig);
  const jobs = new MediaJobsService({
    db,
    queue,
    store: mediaStore,
    emit: broadcast,
    comfy: () => comfyClient,
    now: () => new Date().toISOString(),
  });

  // 上次崩掉 / 被强杀留下的画图任务统一收尾（契约 media.ts：不留「生成中」）
  const repairedMedia = await jobs.repairInterrupted();
  if (repairedMedia > 0) console.warn(`[media] 收尾了 ${repairedMedia} 个上次没跑完的画图任务`);

  const media = new MediaService({
    db,
    store: mediaStore,
    now: () => new Date().toISOString(),
    openFileDialog: async (options) => {
      const result = await dialog.showOpenDialog({
        title: options.title,
        properties: ["openFile"],
        filters: options.filters,
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
  });

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
      // C-40 的 model 也在 target 里：和 e2e harness 共用 nodes.ts 的同一份查询
      const target = resolveRunTarget(db, settings, run);
      const adapter = new HttpRemoteAgentAdapter({
        nodeId: target.nodeId,
        baseUrl: target.baseUrl,
        profileId: target.profileId,
        token: target.token,
        ...(target.model === undefined ? {} : { model: target.model }),
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

  // D-31b：聊天服务。Run 走各自的聊天 profile（只读、无工具），和讨论室的 Run 分开
  const chat = new ChatService({
    db,
    queue,
    repo,
    settings,
    emit: broadcast,
    adapterFactory: async (target) => {
      const adapter = new HttpRemoteAgentAdapter({
        nodeId: target.nodeId,
        baseUrl: target.baseUrl,
        profileId: target.profileId,
        token: target.token,
        ...(target.model === undefined ? {} : { model: target.model }),
        heartbeatTimeoutMs: 15_000,
        reconnectGraceMs: 30_000,
        requestTimeoutMs: 10_000,
      });
      await adapter.initialize();
      return adapter;
    },
  });
  const repairedChat = await chat.repairInterrupted();

  const dispatcher = createDispatcher({
    repo,
    settings,
    orchestrator,
    discussion,
    chat,
    media,
    jobs,
    nodes,
    appVersion: app.getVersion(),
    recoveredRuns: repaired.repaired.length + repairedChat,
    emit: broadcast,
  });

  ipcMain.handle(IPC_CHANNELS.command, async (_event, request: unknown) => dispatcher.handleCommand(request));
  ipcMain.handle(IPC_CHANNELS.query, async (_event, request: unknown) => dispatcher.handleQuery(request));

  app.on("before-quit", () => {
    // 让节点立刻停下，而不是等租约过期（abort 由 orchestrator / chat 统一发出）
    orchestrator.cancelAll();
    chat.cancelAll();
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



