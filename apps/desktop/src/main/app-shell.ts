import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, Menu, screen, session, shell, type WebContents } from "electron";
import { createFileLogger, teeConsole, type FileLogger } from "./logger";
import {
  aboutDetail,
  APP_DISPLAY_NAME,
  buildMenuTemplate,
  decidePermissionCheck,
  decidePermissionRequest,
  describeStartupFailure,
  devToolsEnabled,
  isAppUrl,
  isSafeExternalUrl,
  urlSchemeForLog,
  type AppEntry,
} from "./shell-policy";
import { MIN_WINDOW_SIZE, resolveWindowPlacement, WindowStateStore, type WindowPlacement } from "./window-state";

/**
 * 应用外壳（C-51）：单实例、菜单、窗口状态、外链 / 权限限制、崩溃恢复、日志、启动失败提示。
 *
 * 这里只做「接到 Electron 上」的部分；判断逻辑在 shell-policy.ts / window-state.ts / logger.ts（可单测）。
 * CLI 模式（--self-test 等）不走这里的任何一项，行为保持原样。
 */

// ---------- 日志 + 未捕获异常 ----------

/**
 * 开日志文件，把 console.info / warn / error 抄一份进去，并接住主进程的未捕获异常。
 * 要在数据目录定下来之后、其他启动代码之前调用。
 */
export function startLogging(dataDir: string): FileLogger {
  const logger = createFileLogger({ dir: join(dataDir, "logs") });
  teeConsole(logger);

  let crashing = false;
  process.on("uncaughtException", (error) => {
    if (crashing) {
      // 收尾过程里又出错：不再弹框，直接退
      app.exit(1);
      return;
    }
    crashing = true;
    console.error("[crash] 主进程未捕获异常：", error);
    dialog.showErrorBox(
      `${APP_DISPLAY_NAME} 遇到问题，需要关闭`,
      [
        "程序出了一个没预料到的错误，将会退出。重新打开一般就能继续用；",
        "如果反复出现，请把下面的日志文件发给开发者。",
        "",
        `数据文件夹：${dataDir}`,
        `日志文件：${logger.file}`,
        "",
        `原始报错：${error instanceof Error ? error.message : String(error)}`,
      ].join("\n"),
    );
    // 正常退出能让 before-quit 关库、收子进程；万一卡住，3 秒后强退
    setTimeout(() => app.exit(1), 3000).unref();
    app.quit();
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[crash] 未处理的 Promise 拒绝：", reason);
  });
  return logger;
}

// ---------- 单实例 ----------

/**
 * 抢单实例锁。Electron 的锁按 userData 目录区分，所以必须在 setPath("userData") 之后调用：
 * 不同数据目录的实例（e2e、验收脚本）互不影响。
 * 返回 false = 已经有一个实例在跑，调用方应当直接退出。
 */
export function acquireSingleInstance(onSecondInstance: () => void): boolean {
  if (!app.requestSingleInstanceLock()) return false;
  app.on("second-instance", onSecondInstance);
  return true;
}

/** 第二次启动时：把已有窗口还原、显示并拿到前台 */
export function revealWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

// ---------- 启动失败 ----------

export function showStartupFailure(error: unknown, dataDir: string, logger: FileLogger | null): void {
  console.error("[startup] 启动失败：", error);
  const failure = describeStartupFailure(error, { dataDir, logFile: logger?.file ?? null });
  dialog.showErrorBox(failure.title, failure.body);
}

// ---------- 图标 ----------

/** 开发态和 Linux 用 png 当窗口图标；Windows 安装版用 exe 自带的多尺寸图标，macOS 不看这个参数 */
export function windowIconPath(): string | undefined {
  if (process.platform === "darwin") return undefined;
  if (process.platform === "win32" && app.isPackaged) return undefined;
  const file = join(app.getAppPath(), "build", "icon.png");
  return existsSync(file) ? file : undefined;
}

// ---------- 应用级：菜单、权限、webContents 加固 ----------

export interface AppShellOptions {
  entry: AppEntry;
  logger: FileLogger | null;
  getMainWindow: () => BrowserWindow | null;
}

function showAbout(parent: BrowserWindow | null): void {
  const options = {
    type: "info" as const,
    title: `关于 ${APP_DISPLAY_NAME}`,
    message: APP_DISPLAY_NAME,
    detail: aboutDetail(app.getVersion(), process.env["ROOM_BUILD_SHA"]),
    buttons: ["好的"],
    noLink: true,
  };
  void (parent === null ? dialog.showMessageBox(options) : dialog.showMessageBox(parent, options));
}

function openFolder(path: string): void {
  void shell.openPath(path).then((problem) => {
    if (problem !== "") console.warn("[shell] 打不开文件夹：" + problem);
  });
}

function installMenu(options: AppShellOptions): void {
  const template = buildMenuTemplate({
    platform: process.platform,
    devTools: devToolsEnabled(app.isPackaged, process.env["ROOM_DEVTOOLS"]),
    actions: {
      // 当前正在用的那份资料（切到恢复副本时就是副本目录）
      openDataFolder: () => openFolder(app.getPath("userData")),
      openLogFolder: () => openFolder(options.logger?.dir ?? app.getPath("userData")),
      showAbout: () => showAbout(options.getMainWindow()),
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installPermissions(entry: AppEntry): void {
  const target = session.defaultSession;
  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    const url = details.requestingUrl ?? contents.getURL();
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    const allowed = decidePermissionRequest(permission, { fromApp: isAppUrl(url, entry), mediaTypes });
    if (!allowed) console.warn(`[shell] 拒绝权限请求：${permission}`);
    callback(allowed);
  });
  target.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const url = details.requestingUrl ?? contents?.getURL() ?? "";
    return decidePermissionCheck(permission, { fromApp: isAppUrl(url, entry), mediaType: details.mediaType });
  });
}

function hardenWebContents(contents: WebContents, entry: AppEntry): void {
  // 页面开新窗口一律不开；只有网页 / 邮件链接交给系统浏览器
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url).catch((error: unknown) => console.warn("[shell] 打开外部链接失败：", error));
    } else {
      console.warn(`[shell] 拒绝打开外部链接（协议 ${urlSchemeForLog(url)}）`);
    }
    return { action: "deny" };
  });
  // 页面只能待在应用自己的页面上，不能被带去别的地址
  contents.on("will-navigate", (event, url) => {
    if (isAppUrl(url, entry)) return;
    // 开发者工具自己的窗口不归这条管（只有开了 devtools 菜单时才会有）
    if (url.startsWith("devtools://")) return;
    event.preventDefault();
    console.warn(`[shell] 拒绝页面跳转（协议 ${urlSchemeForLog(url)}）`);
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
    console.warn("[shell] 拒绝嵌入 webview");
  });
}

/** app ready 之后、开窗口之前调用一次 */
export function installAppShell(options: AppShellOptions): void {
  if (process.platform === "win32") {
    // 和安装包快捷方式的 AppUserModelId 一致，任务栏才会归到同一个图标下
    app.setAppUserModelId("com.agent-review-room.desktop");
  }
  installMenu(options);
  installPermissions(options.entry);
  app.on("web-contents-created", (_event, contents) => hardenWebContents(contents, options.entry));
  app.on("child-process-gone", (_event, details) => {
    console.warn(
      `[crash] 子进程退出：type=${details.type} reason=${details.reason} exitCode=${details.exitCode}` +
        (details.name === undefined ? "" : ` name=${details.name}`),
    );
  });
}

// ---------- 窗口级：状态记忆、崩溃恢复 ----------

export function createWindowStateStore(dataDir: string): WindowStateStore {
  let warned = false;
  return new WindowStateStore(join(dataDir, "window-state.json"), {
    onError: (error) => {
      if (warned) return;
      warned = true;
      console.warn("[shell] 窗口位置没能保存：", error instanceof Error ? error.message : String(error));
    },
  });
}

/** 开窗前：按上次的状态和现在接着的显示器算出窗口放哪（app ready 之后才能调用） */
export function restoredPlacement(store: WindowStateStore): WindowPlacement {
  return resolveWindowPlacement(
    store.load(),
    screen.getAllDisplays().map((display) => display.workArea),
  );
}

export function trackWindowState(window: BrowserWindow, store: WindowStateStore): void {
  const capture = (): void => {
    if (window.isDestroyed()) return;
    // 最大化 / 全屏 / 最小化时 getNormalBounds 仍是「还原后」的大小，正好是要记的
    const bounds = window.getNormalBounds();
    if (bounds.width < MIN_WINDOW_SIZE.width / 2 || bounds.height < MIN_WINDOW_SIZE.height / 2) return;
    store.update({ ...bounds, maximized: window.isMaximized() });
  };
  window.on("resize", capture);
  window.on("move", capture);
  window.on("maximize", capture);
  window.on("unmaximize", capture);
  window.on("close", () => {
    capture();
    store.flush();
  });
}

/** 渲染进程崩溃 / 卡死 / 页面加载失败时给用户一个选择，而不是留一个白屏 */
export function installCrashRecovery(window: BrowserWindow): void {
  const contents = window.webContents;
  let dialogOpen = false;
  /** 「无响应 → 重新加载」是我们自己杀的渲染进程，不用再弹一次「崩溃了」 */
  let killedByUs = false;
  let hangDialog: AbortController | null = null;

  const askReloadOrQuit = async (message: string, detail: string): Promise<void> => {
    if (dialogOpen || window.isDestroyed()) return;
    dialogOpen = true;
    try {
      const result = await dialog.showMessageBox(window, {
        type: "error",
        title: APP_DISPLAY_NAME,
        message,
        detail,
        buttons: ["重新加载", "退出"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) {
        if (!window.isDestroyed()) contents.reload();
      } else {
        app.quit();
      }
    } finally {
      dialogOpen = false;
    }
  };

  contents.on("render-process-gone", (_event, details) => {
    console.error(`[crash] 渲染进程退出：reason=${details.reason} exitCode=${details.exitCode}`);
    if (details.reason === "clean-exit") return;
    if (killedByUs) {
      killedByUs = false;
      return;
    }
    void askReloadOrQuit(
      "界面出了问题，已经停止工作",
      details.reason === "oom"
        ? "内存不够用了。已经保存的聊天和笔记不受影响，重新加载后可以继续。"
        : "已经保存的聊天和笔记不受影响，重新加载后可以继续。",
    );
  });

  contents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
    // -3 = 被新的加载打断（比如连点两次重新加载），不算失败
    if (!isMainFrame || errorCode === -3) return;
    console.error(`[shell] 页面加载失败：${errorCode} ${errorDescription}`);
    void askReloadOrQuit(
      "界面没能加载出来",
      `可以重新加载试试；还是不行的话请重新安装。\n（${errorCode} ${errorDescription}）`,
    );
  });

  window.on("unresponsive", () => {
    console.warn("[crash] 界面无响应");
    if (dialogOpen || window.isDestroyed()) return;
    dialogOpen = true;
    const controller = new AbortController();
    hangDialog = controller;
    void dialog
      .showMessageBox(window, {
        type: "warning",
        title: APP_DISPLAY_NAME,
        message: "界面暂时没有响应",
        detail: "可以再等一会儿；一直不恢复的话，重新加载界面（已经保存的聊天和笔记不受影响）。",
        buttons: ["继续等", "重新加载"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal: controller.signal,
      })
      .then((result) => {
        if (result.response !== 1 || window.isDestroyed() || controller.signal.aborted) return;
        // 卡死的页面 reload 不动，先把渲染进程杀掉再加载
        killedByUs = true;
        contents.forcefullyCrashRenderer();
        contents.reload();
      })
      .catch(() => undefined)
      .finally(() => {
        dialogOpen = false;
        if (hangDialog === controller) hangDialog = null;
      });
  });
  window.on("responsive", () => {
    if (hangDialog === null) return;
    console.info("[crash] 界面恢复响应");
    // 自己好了就把提示收掉
    hangDialog.abort();
  });
}
