import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { createFileLogger, formatLogLine, redactSecrets, teeConsole } from "../src/main/logger";
import {
  aboutDetail,
  buildMenuTemplate,
  decidePermissionCheck,
  decidePermissionRequest,
  describeStartupFailure,
  devToolsEnabled,
  isAppUrl,
  isSafeExternalUrl,
} from "../src/main/shell-policy";
import { parseWindowState, resolveWindowPlacement, WindowStateStore } from "../src/main/window-state";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 句柄释放有延迟
    }
  }
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "room-shell-"));
  dirs.push(dir);
  return dir;
}

describe("外链白名单", () => {
  it("只放 http / https / mailto", () => {
    assert.equal(isSafeExternalUrl("https://example.com/a?b=1"), true);
    assert.equal(isSafeExternalUrl("http://example.com"), true);
    assert.equal(isSafeExternalUrl("mailto:someone@example.com"), true);
  });

  it("file、自定义协议、javascript、乱写的一律拒绝", () => {
    for (const url of [
      "file:///etc/passwd",
      "file:///C:/Windows/System32/calc.exe",
      "ms-msdt:/id PCWDiagnostic",
      "javascript:alert(1)",
      "room-image://abc",
      "smb://host/share",
      "data:text/html,<b>x</b>",
      "not a url",
      "",
    ]) {
      assert.equal(isSafeExternalUrl(url), false, url);
    }
  });
});

describe("应用页面判断", () => {
  it("打包后只认 index.html 这一个文件，别的 file:// 不算", () => {
    const path = join(temp(), "renderer", "index.html");
    const entry = { kind: "file", path } as const;
    assert.equal(isAppUrl(pathToFileURL(path).href, entry), true);
    assert.equal(isAppUrl(pathToFileURL(path).href + "#/chat", entry), true);
    assert.equal(isAppUrl("file:///etc/passwd", entry), false);
    assert.equal(isAppUrl("https://example.com", entry), false);
    assert.equal(isAppUrl("乱写", entry), false);
  });

  it("目录带中文（productName 是中文）也认得", () => {
    const path = join(temp(), "评审室", "index.html");
    assert.equal(isAppUrl(pathToFileURL(path).href, { kind: "file", path }), true);
  });

  it("开发态按 dev server 的 origin 判断", () => {
    const entry = { kind: "dev", origin: "http://localhost:5173" } as const;
    assert.equal(isAppUrl("http://localhost:5173/index.html", entry), true);
    assert.equal(isAppUrl("http://localhost:5173.evil.com/", entry), false);
    assert.equal(isAppUrl("file:///etc/passwd", entry), false);
  });
});

describe("权限", () => {
  it("应用页面：只放录音和写剪贴板", () => {
    assert.equal(decidePermissionRequest("media", { fromApp: true, mediaTypes: ["audio"] }), true);
    assert.equal(decidePermissionRequest("clipboard-sanitized-write", { fromApp: true }), true);
  });

  it("摄像头、音视频一起要、没说要什么的 media 都拒绝", () => {
    assert.equal(decidePermissionRequest("media", { fromApp: true, mediaTypes: ["video"] }), false);
    assert.equal(decidePermissionRequest("media", { fromApp: true, mediaTypes: ["audio", "video"] }), false);
    assert.equal(decidePermissionRequest("media", { fromApp: true, mediaTypes: [] }), false);
    assert.equal(decidePermissionRequest("media", { fromApp: true }), false);
  });

  it("其它权限全部拒绝", () => {
    for (const permission of ["geolocation", "notifications", "clipboard-read", "display-capture", "openExternal", "fullscreen", "hid", "usb"]) {
      assert.equal(decidePermissionRequest(permission, { fromApp: true }), false, permission);
      assert.equal(decidePermissionCheck(permission, { fromApp: true }), false, permission);
    }
  });

  it("不是应用自己的页面，什么都不给", () => {
    assert.equal(decidePermissionRequest("media", { fromApp: false, mediaTypes: ["audio"] }), false);
    assert.equal(decidePermissionRequest("clipboard-sanitized-write", { fromApp: false }), false);
    assert.equal(decidePermissionCheck("media", { fromApp: false, mediaType: "audio" }), false);
  });

  it("权限查询和请求口径一致", () => {
    assert.equal(decidePermissionCheck("media", { fromApp: true, mediaType: "audio" }), true);
    assert.equal(decidePermissionCheck("media", { fromApp: true, mediaType: "video" }), false);
    assert.equal(decidePermissionCheck("media", { fromApp: true, mediaType: "unknown" }), false);
    assert.equal(decidePermissionCheck("clipboard-sanitized-write", { fromApp: true }), true);
  });
});

describe("应用菜单", () => {
  const actions = { openDataFolder: () => undefined, openLogFolder: () => undefined, showAbout: () => undefined };
  const flatten = (template: ReturnType<typeof buildMenuTemplate>): { label: string; role: string }[] =>
    template.flatMap((menu) => [
      { label: menu.label ?? "", role: String(menu.role ?? "") },
      ...(Array.isArray(menu.submenu) ? menu.submenu : []).map((item) => ({ label: item.label ?? "", role: String(item.role ?? "") })),
    ]);

  it("Windows：文件 / 编辑 / 视图 / 窗口 / 帮助，全是中文", () => {
    const template = buildMenuTemplate({ platform: "win32", devTools: false, actions });
    assert.deepEqual(template.map((menu) => menu.label), ["文件", "编辑", "视图", "窗口", "帮助"]);
    for (const item of flatten(template)) {
      if (item.label === "") continue; // 分隔线
      assert.match(item.label, /[\u4e00-\u9fff]/, item.label);
    }
    const labels = flatten(template).map((item) => item.label);
    for (const expected of ["退出", "撤销", "重做", "剪切", "复制", "粘贴", "全选", "实际大小", "放大", "缩小", "全屏", "打开数据文件夹", "打开日志文件夹", "关于 Agent 评审室"]) {
      assert.ok(labels.includes(expected), expected);
    }
  });

  it("打包态没有开发者工具和重新加载", () => {
    const items = flatten(buildMenuTemplate({ platform: "win32", devTools: false, actions }));
    assert.equal(items.some((item) => item.role === "toggleDevTools" || item.role === "reload" || item.role === "forceReload"), false);
    assert.equal(items.some((item) => /开发者|重新加载/.test(item.label)), false);
  });

  it("开发态 / ROOM_DEVTOOLS=1 才有", () => {
    const items = flatten(buildMenuTemplate({ platform: "win32", devTools: true, actions }));
    assert.ok(items.some((item) => item.role === "toggleDevTools"));
    assert.ok(items.some((item) => item.role === "reload"));

    assert.equal(devToolsEnabled(true, undefined), false);
    assert.equal(devToolsEnabled(true, "1"), true);
    assert.equal(devToolsEnabled(false, undefined), true);
    assert.equal(devToolsEnabled(false, "0"), false);
    assert.equal(devToolsEnabled(true, "true"), false);
  });

  it("macOS 多一个应用菜单，关于放在里面", () => {
    const template = buildMenuTemplate({ platform: "darwin", devTools: false, actions });
    assert.deepEqual(template.map((menu) => menu.label), ["Agent 评审室", "文件", "编辑", "视图", "窗口", "帮助"]);
    const labels = flatten(template).map((item) => item.label);
    assert.equal(labels.filter((label) => label === "关于 Agent 评审室").length, 1);
  });

  it("关于：版本 + 数据在本机的说明", () => {
    const detail = aboutDetail("0.1.0-dev.0", "0123456789abcdef");
    assert.match(detail, /版本 0\.1\.0-dev\.0（构建 0123456）/);
    assert.match(detail, /只保存在这台电脑上/);
    assert.match(aboutDetail("1.0.0", "development"), /^版本 1\.0\.0\n/);
  });
});

describe("启动失败提示", () => {
  const context = { dataDir: "C:\\Users\\a\\AppData\\Roaming\\评审室", logFile: "C:\\Users\\a\\AppData\\Roaming\\评审室\\logs\\main.log" };

  it("EPERM（#208）：说是目录写不进去，带上目录和日志位置", () => {
    const error = Object.assign(new Error("EPERM: operation not permitted, open 'C:\\x\\room.db'"), { code: "EPERM" });
    const { title, body } = describeStartupFailure(error, context);
    assert.equal(title, "Agent 评审室 启动失败");
    assert.match(body, /数据文件夹写不进去/);
    assert.ok(body.includes(context.dataDir));
    assert.ok(body.includes(context.logFile));
    assert.match(body, /原始报错：EPERM/);
  });

  it("数据库被占用", () => {
    const error = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    assert.match(describeStartupFailure(error, context).body, /正被另一个程序占用/);
  });

  it("认不出来的错：两种可能都列出来；没有日志时也说清楚", () => {
    const { body } = describeStartupFailure("迁移 v27 失败", { dataDir: "/data", logFile: null });
    assert.match(body, /写不进去/);
    assert.match(body, /占用/);
    assert.match(body, /没能写出日志文件/);
    assert.match(body, /原始报错：迁移 v27 失败/);
  });
});

describe("窗口状态", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };

  it("坏数据当没有", () => {
    assert.equal(parseWindowState(null), null);
    assert.equal(parseWindowState("x"), null);
    assert.equal(parseWindowState({ x: 0, y: 0, width: "a", height: 1 }), null);
    assert.equal(parseWindowState({ x: 0, y: 0, width: 0, height: 100 }), null);
    assert.equal(parseWindowState({ x: Number.NaN, y: 0, width: 100, height: 100 }), null);
    assert.equal(parseWindowState({ x: 1e12, y: 0, width: 100, height: 100 }), null);
    assert.deepEqual(parseWindowState({ x: 1.4, y: 2, width: 1000, height: 700, maximized: "yes" }), {
      x: 1,
      y: 2,
      width: 1000,
      height: 700,
      maximized: false,
    });
  });

  it("没有记录：默认 1280×800，位置交给系统", () => {
    assert.deepEqual(resolveWindowPlacement(null, [primary]), { width: 1280, height: 800, maximized: false });
  });

  it("还在屏幕里：原样恢复，包括最大化", () => {
    const saved = { x: 100, y: 80, width: 1400, height: 900, maximized: true };
    assert.deepEqual(resolveWindowPlacement(saved, [primary]), saved);
  });

  it("在第二块屏上（负坐标）也算", () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1080 };
    const saved = { x: -1800, y: 100, width: 1200, height: 800, maximized: false };
    assert.deepEqual(resolveWindowPlacement(saved, [primary, left]), saved);
  });

  it("那块屏拔掉了 / 标题栏跑到屏幕外：回默认", () => {
    const fallback = { width: 1280, height: 800, maximized: false };
    assert.deepEqual(resolveWindowPlacement({ x: -1800, y: 100, width: 1200, height: 800, maximized: true }, [primary]), fallback);
    assert.deepEqual(resolveWindowPlacement({ x: 100, y: -500, width: 1200, height: 800, maximized: false }, [primary]), fallback);
    assert.deepEqual(resolveWindowPlacement({ x: 1900, y: 100, width: 1200, height: 800, maximized: false }, [primary]), fallback);
    assert.deepEqual(resolveWindowPlacement({ x: 100, y: 1030, width: 1200, height: 800, maximized: false }, [primary]), fallback);
    assert.deepEqual(resolveWindowPlacement({ x: 0, y: 0, width: 1200, height: 800, maximized: false }, []), fallback);
  });

  it("比屏幕大就缩到屏幕大小，比最小尺寸小就放大到最小尺寸", () => {
    const small = { x: 0, y: 0, width: 1366, height: 728 };
    assert.deepEqual(resolveWindowPlacement({ x: 0, y: 0, width: 2560, height: 1400, maximized: false }, [small]), {
      x: 0,
      y: 0,
      width: 1366,
      height: 728,
      maximized: false,
    });
    const tiny = resolveWindowPlacement({ x: 10, y: 10, width: 300, height: 200, maximized: false }, [primary]);
    assert.equal(tiny.width, 960);
    assert.equal(tiny.height, 600);
  });

  it("存取：防抖只写最后一次，原子写不留 tmp；坏文件读成 null", async () => {
    const dir = temp();
    const file = join(dir, "sub", "window-state.json");
    const store = new WindowStateStore(file, { debounceMs: 20 });
    assert.equal(store.load(), null);

    store.update({ x: 1, y: 2, width: 1000, height: 700, maximized: false });
    store.update({ x: 5, y: 6, width: 1100, height: 720, maximized: true });
    assert.equal(existsSync(file), false, "防抖期间还没写");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { x: 5, y: 6, width: 1100, height: 720, maximized: true });
    assert.deepEqual(readdirSync(join(dir, "sub")), ["window-state.json"]);
    assert.deepEqual(store.load(), { x: 5, y: 6, width: 1100, height: 720, maximized: true });

    store.update({ x: 9, y: 9, width: 1000, height: 700, maximized: false });
    store.flush();
    assert.equal(store.load()?.x, 9);

    writeFileSync(file, "{ 坏的", "utf8");
    assert.equal(store.load(), null);
  });

  it("写不进去不抛错，只回调", () => {
    const dir = temp();
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const errors: unknown[] = [];
    const store = new WindowStateStore(join(blocker, "window-state.json"), { onError: (error) => errors.push(error) });
    store.update({ x: 0, y: 0, width: 1000, height: 700, maximized: false });
    assert.doesNotThrow(() => store.flush());
    assert.equal(errors.length, 1);
  });
});

describe("日志文件", () => {
  const at = new Date("2026-11-13T08:00:00.000Z");

  it("一行一条，带时间戳和级别；Error 带堆栈", () => {
    assert.equal(formatLogLine("warn", ["[tts] 没配好", 3, { a: 1 }], at), "2026-11-13T08:00:00.000Z [warn] [tts] 没配好 3 { a: 1 }\n");
    assert.match(formatLogLine("error", [new Error("炸了")], at), /\[error\] Error: 炸了\n\s+at /);
  });

  it("兜底打码：常见形状的密钥不进文件", () => {
    const text = redactSecrets("Authorization: Bearer abcdefghijklmnop123 / ghp_ABCDEFGHIJKLMNOPQRSTUVWX123456 / github_pat_11ABCDEFG0abcdefghijkl_xyz / sk-ant-abcdefghijklmnop1234");
    assert.doesNotMatch(text, /abcdefghijklmnop123|ghp_|github_pat_|sk-ant/);
    assert.match(text, /Bearer \[已隐藏\]/);
    assert.equal(redactSecrets("[startup] 普通的一行，task-id sk-1 不算"), "[startup] 普通的一行，task-id sk-1 不算");
  });

  it("写到 logs/main.log；超过上限轮转，只留 2 份旧的", () => {
    const dir = join(temp(), "logs");
    const logger = createFileLogger({ dir, maxBytes: 200, keep: 2, now: () => at });
    for (let index = 0; index < 40; index += 1) logger.write("info", [`第 ${index} 行 ${"x".repeat(40)}`]);
    assert.deepEqual(readdirSync(dir).sort(), ["main.1.log", "main.2.log", "main.log"]);
    for (const name of readdirSync(dir)) {
      assert.ok(readFileSync(join(dir, name)).length <= 200, name);
    }
    // 最新的一行在 main.log 里，最老的已经被丢掉
    assert.match(readFileSync(join(dir, "main.log"), "utf8"), /第 39 行/);
    const all = readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8")).join("");
    assert.doesNotMatch(all, /第 0 行/);
  });

  it("接着已有的文件写", () => {
    const dir = temp();
    createFileLogger({ dir, now: () => at }).write("info", ["第一次启动"]);
    createFileLogger({ dir, now: () => at }).write("info", ["第二次启动"]);
    assert.match(readFileSync(join(dir, "main.log"), "utf8"), /第一次启动\n.*第二次启动\n$/);
  });

  it("目录写不了：不抛错", () => {
    const dir = temp();
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    const logger = createFileLogger({ dir: join(blocker, "logs") });
    assert.doesNotThrow(() => logger.write("error", ["写不进去"]));
  });

  it("tee：console 原样输出，同时进文件；console.log 不动", () => {
    const dir = temp();
    const seen: string[] = [];
    const fake = {
      info: (...args: unknown[]) => void seen.push("info:" + args.join(" ")),
      warn: (...args: unknown[]) => void seen.push("warn:" + args.join(" ")),
      error: (...args: unknown[]) => void seen.push("error:" + args.join(" ")),
    };
    const restore = teeConsole(createFileLogger({ dir, now: () => at }), fake);
    fake.info("a");
    fake.warn("b", 1);
    fake.error("c");
    restore();
    fake.info("还原之后");
    assert.deepEqual(seen, ["info:a", "warn:b 1", "error:c", "info:还原之后"]);
    const text = readFileSync(join(dir, "main.log"), "utf8");
    assert.match(text, /\[info\] a\n.*\[warn\] b 1\n.*\[error\] c\n$/);
    assert.doesNotMatch(text, /还原之后/);
  });
});
