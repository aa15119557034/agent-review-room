import { fileURLToPath } from "node:url";
import type { MenuItemConstructorOptions } from "electron";

/**
 * 应用外壳里「拿主意」的纯函数（C-51）：外链放不放、权限给不给、菜单长什么样、
 * 启动失败怎么跟用户说。只有类型来自 electron，运行时不依赖它，可以直接单测。
 */

export const APP_DISPLAY_NAME = "Agent 评审室";

// ---------- 外链 ----------

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** 只有网页和邮件链接才交给系统打开；file:、自定义协议、javascript: 等一律不放 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** 记日志只记协议，不记整条链接（链接里可能带隐私） */
export function urlSchemeForLog(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "（不是合法链接）";
  }
}

// ---------- 应用自己的页面 ----------

/** 应用页面从哪儿加载：打包后是 out/renderer/index.html，开发时是 dev server */
export type AppEntry = { kind: "file"; path: string } | { kind: "dev"; origin: string };

/** 这个地址是不是应用自己的页面（导航限制和权限判断都靠它） */
export function isAppUrl(url: string, entry: AppEntry, platform: NodeJS.Platform = process.platform): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (entry.kind === "dev") return parsed.origin === entry.origin;
  if (parsed.protocol !== "file:") return false;
  try {
    const path = fileURLToPath(parsed);
    // Windows 路径不分大小写
    return platform === "win32" ? path.toLowerCase() === entry.path.toLowerCase() : path === entry.path;
  } catch {
    return false;
  }
}

// ---------- 权限 ----------

export interface PermissionRequestInfo {
  /** 请求是不是来自应用自己的页面 */
  fromApp: boolean;
  /** media 请求要的是哪几种（audio / video） */
  mediaTypes?: readonly string[] | undefined;
}

/**
 * 页面弹权限请求时放不放。
 * 只放应用真用到的两样：录音（renderer 的语音输入用 getUserMedia({ audio: true })）
 * 和「复制」按钮写剪贴板。摄像头、定位、通知、屏幕共享等全部拒绝。
 */
export function decidePermissionRequest(permission: string, info: PermissionRequestInfo): boolean {
  if (!info.fromApp) return false;
  if (permission === "media") {
    const types = info.mediaTypes ?? [];
    return types.length > 0 && types.every((type) => type === "audio");
  }
  return permission === "clipboard-sanitized-write";
}

export interface PermissionCheckInfo {
  fromApp: boolean;
  /** media 检查的是哪一种：audio / video / unknown */
  mediaType?: string | undefined;
}

/** 页面查询「我有没有这个权限」时怎么答；规则和上面一致 */
export function decidePermissionCheck(permission: string, info: PermissionCheckInfo): boolean {
  if (!info.fromApp) return false;
  if (permission === "media") return info.mediaType === "audio";
  return permission === "clipboard-sanitized-write";
}

// ---------- 菜单 ----------

/** 开发者工具 / 重新加载：没打包时默认有；ROOM_DEVTOOLS=1 强制有，=0 强制没有 */
export function devToolsEnabled(isPackaged: boolean, flag: string | undefined): boolean {
  if (flag === "1") return true;
  if (flag === "0") return false;
  return !isPackaged;
}

export interface MenuActions {
  openDataFolder: () => void;
  openLogFolder: () => void;
  showAbout: () => void;
}

export interface MenuOptions {
  platform: NodeJS.Platform;
  devTools: boolean;
  actions: MenuActions;
}

/** 中文应用菜单。role 交给 Electron 实现功能，这里只定文字和结构 */
export function buildMenuTemplate(options: MenuOptions): MenuItemConstructorOptions[] {
  const { platform, devTools, actions } = options;
  const isMac = platform === "darwin";
  const separator: MenuItemConstructorOptions = { type: "separator" };

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: APP_DISPLAY_NAME,
          submenu: [
            { label: `关于 ${APP_DISPLAY_NAME}`, click: actions.showAbout },
            separator,
            { label: "服务", role: "services" },
            separator,
            { label: `隐藏 ${APP_DISPLAY_NAME}`, role: "hide" },
            { label: "隐藏其他", role: "hideOthers" },
            { label: "全部显示", role: "unhide" },
            separator,
            { label: `退出 ${APP_DISPLAY_NAME}`, role: "quit" },
          ],
        },
      ]
    : [];

  const fileMenu: MenuItemConstructorOptions = {
    label: "文件",
    submenu: isMac ? [{ label: "关闭窗口", role: "close" }] : [{ label: "退出", role: "quit" }],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: "编辑",
    submenu: [
      { label: "撤销", role: "undo" },
      { label: "重做", role: "redo" },
      separator,
      { label: "剪切", role: "cut" },
      { label: "复制", role: "copy" },
      { label: "粘贴", role: "paste" },
      { label: "全选", role: "selectAll" },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "视图",
    submenu: [
      { label: "实际大小", role: "resetZoom" },
      { label: "放大", role: "zoomIn" },
      { label: "缩小", role: "zoomOut" },
      separator,
      { label: "全屏", role: "togglefullscreen" },
      ...(devTools
        ? ([
            separator,
            { label: "重新加载", role: "reload" },
            { label: "开发者工具", role: "toggleDevTools" },
          ] satisfies MenuItemConstructorOptions[])
        : []),
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: "窗口",
    role: "window",
    submenu: isMac
      ? [
          { label: "最小化", role: "minimize" },
          { label: "缩放", role: "zoom" },
          separator,
          { label: "全部置于顶层", role: "front" },
        ]
      : [
          { label: "最小化", role: "minimize" },
          { label: "关闭", role: "close" },
        ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: "帮助",
    role: "help",
    submenu: [
      { label: "打开数据文件夹", click: actions.openDataFolder },
      { label: "打开日志文件夹", click: actions.openLogFolder },
      ...(isMac ? [] : ([separator, { label: `关于 ${APP_DISPLAY_NAME}`, click: actions.showAbout }] satisfies MenuItemConstructorOptions[])),
    ],
  };

  return [...appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}

/** 「关于」对话框里的说明文字 */
export function aboutDetail(version: string, revision: string | undefined): string {
  const build = revision !== undefined && /^[0-9a-f]{7,}$/i.test(revision) ? `（构建 ${revision.slice(0, 7)}）` : "";
  return [
    `版本 ${version}${build}`,
    "",
    "聊天记录、笔记和设置只保存在这台电脑上（帮助 → 打开数据文件夹）。",
    "只有你自己配置的节点和 GitHub 同步会收到对应的内容。",
  ].join("\n");
}

// ---------- 启动失败 ----------

export interface StartupFailureContext {
  /** 数据目录 */
  dataDir: string;
  /** 日志文件；没有日志时为 null */
  logFile: string | null;
}

function errorCode(error: unknown): string {
  // 顺着 cause 多看两层：错误被包装过（new Error(msg, { cause })）也能认出原来的 SQLITE_* / E* 代码
  let current: unknown = error;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : null;
  }
  return "";
}

/**
 * 启动失败时给普通用户看的说明：先说最可能的原因和能做什么，再给数据目录、日志位置和原始报错。
 * issue #208（安装包启动 EPERM）根因未明，这里只保证能看到明确的中文说明，不改目录位置。
 */
export function describeStartupFailure(error: unknown, context: StartupFailureContext): { title: string; body: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  const text = `${code} ${message}`;

  const notWritable = /\b(EPERM|EACCES|EROFS|ENOSPC|SQLITE_READONLY|SQLITE_CANTOPEN)\b|operation not permitted|permission denied|readonly database|unable to open database/i.test(text);
  const locked = /\b(EBUSY|SQLITE_BUSY|SQLITE_LOCKED)\b|database is locked/i.test(text);

  // 数据库文件本身坏了（断电、磁盘故障、被别的程序改写）。先于「写不进去」判断：坏库有时也带 CANTOPEN 字样
  const corrupt = /\b(SQLITE_NOTADB|SQLITE_CORRUPT\w*)\b|file is not a database|database disk image is malformed|malformed database schema/i.test(text);

  const reasons: string[] = [];
  if (corrupt) {
    reasons.push(
      "数据库文件（room.db）已经损坏，应用读不了它。常见原因是写入时断电、磁盘故障，或文件被别的程序改过。",
      "可以试试：",
      "· 如果你用「资料与维护」做过备份，把备份里的 room.db 放回数据文件夹再打开。",
      "· 没有备份的话，把数据文件夹里的 room.db（连同 room.db-wal、room.db-shm）改个名字留着，再打开应用会从空白开始；改名的旧文件不要删，以后也许还能找人修复。",
    );
  } else if (notWritable) {
    reasons.push("很可能是数据文件夹写不进去：被安全软件拦住了、没有写入权限，或者磁盘满了。", "可以试试：把这个文件夹加到安全软件的信任名单，或者检查磁盘空间后再打开。");
  } else if (locked) {
    reasons.push("很可能是数据库正被另一个程序占用：比如评审室已经开着一个，或者同步盘 / 备份软件正在读它。", "可以试试：关掉其他评审室窗口和正在同步这个文件夹的软件，再重新打开。");
  } else {
    reasons.push("可能的原因：", "· 数据文件夹写不进去（被安全软件拦住、没有权限或磁盘已满）", "· 数据库正被另一个程序占用（已经开着一个评审室，或同步盘正在读它）");
  }

  const body = [
    "Agent 评审室没能启动。",
    "",
    ...reasons,
    "",
    `数据文件夹：${context.dataDir}`,
    context.logFile === null ? "日志：这次没能写出日志文件" : `日志文件：${context.logFile}`,
    "",
    `原始报错：${message}`,
  ].join("\n");
  return { title: `${APP_DISPLAY_NAME} 启动失败`, body };
}
