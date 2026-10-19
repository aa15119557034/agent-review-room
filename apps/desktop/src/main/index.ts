import { app, BrowserWindow, nativeTheme, shell } from "electron";
import { join } from "node:path";

/**
 * Electron 主进程入口（DeepSeek 负责）。
 * D-01 只负责：创建窗口并加载 renderer；IPC handler 归 D-07，
 * 数据库初始化归 D-02/D-06，这里都不做。
 */

const isDev = !app.isPackaged;

/** 和 renderer 的 styles.css 里 --paper 对齐，避免启动时闪一下不协调的底色。 */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#131b1f" : "#e9eeec";
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
      // 显式声明：renderer 运行在沙箱里，只能用 preload 暴露的能力
      sandbox: true,
    },
  });

  // 先渲染再显示，避免白屏闪烁
  window.once("ready-to-show", () => window.show());

  // 外部链接交给系统浏览器，不在应用内开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // setWindowOpenHandler 管不到页面内导航：任何内容想把主窗口带到外部站点，一律拦下
  window.webContents.on("will-navigate", (event, url) => {
    const allowed =
      devServerUrl !== undefined ? url.startsWith(devServerUrl) : url.startsWith("file://");
    if (!allowed) event.preventDefault();
  });

  if (isDev && devServerUrl !== undefined) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

void app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
