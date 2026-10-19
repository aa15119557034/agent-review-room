/**
 * better-sqlite3 × Electron 冒烟测试（D-01 验收项）。
 *
 * 直接跑在 Electron 主进程里，用 Electron 的 ABI 加载原生模块，
 * 建库、开 WAL、写一行、读回来，然后退出。
 *
 *   pnpm --filter @room/desktop verify:sqlite
 */
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function fail(error) {
  console.error("SMOKE FAILED:", error && error.stack ? error.stack : error);
  app.exit(1);
}

app.whenReady().then(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-sqlite-smoke-"));
  const file = path.join(dir, "smoke.db");

  try {
    const Database = require("better-sqlite3");
    const db = new Database(file);

    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO probe (value) VALUES (?)").run("agent-review-room");
    const row = db.prepare("SELECT value FROM probe WHERE id = 1").get();

    console.log("electron        :", process.versions.electron);
    console.log("node            :", process.versions.node);
    console.log("modules ABI     :", process.versions.modules);
    console.log("better-sqlite3  :", require("better-sqlite3/package.json").version);
    console.log("sqlite          :", db.prepare("SELECT sqlite_version() AS v").get().v);
    console.log("journal_mode    :", db.pragma("journal_mode", { simple: true }));
    console.log("busy_timeout    :", db.pragma("busy_timeout", { simple: true }));
    console.log("db file         :", file);
    console.log("roundtrip row   :", JSON.stringify(row));

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("SMOKE OK");
    app.exit(0);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    fail(error);
  }
});
