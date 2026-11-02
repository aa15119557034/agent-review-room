import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ChatWindowDraft } from "@room/schemas";
import { openDatabase } from "../src/database";
import { insertChatWindowDraft, updateChatWindowDraft } from "../src/chat-windows";
import { ulid } from "../src/ulid";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 上句柄释放有延迟
    }
  }
});

const NOW = "2026-11-03T00:00:00.000Z";

function draft(patch: Partial<ChatWindowDraft> = {}): ChatWindowDraft {
  return {
    id: "cwd_" + ulid(),
    conversationId: "conv_01JAAAAAAAAAAAAAAAAAAAAAAA",
    agent: "deepseek",
    startsAfterMessageId: "cmsg_01JAAAAAAAAAAAAAAAAAAAAAAA",
    runId: null,
    content: null,
    contentHash: null,
    contentBy: null,
    state: "pending",
    windowId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  } as ChatWindowDraft;
}

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "room-windows-"));
  dirs.push(dir);
  return openDatabase(join(dir, "test.db"));
}

describe("chat window drafts (#187 状态条件更新)", () => {
  it("guard 不匹配就一行都不改：终态不能回退，hash 变了不能覆盖", () => {
    const db = fresh();
    try {
      // 直接插一条 pending（不经过会话外键：测试只看条件 UPDATE）
      db.exec("PRAGMA foreign_keys = OFF");
      const base = draft();
      insertChatWindowDraft(db, base);

      const cancelled = { ...base, state: "cancelled" as const, updatedAt: "2026-11-03T00:00:01.000Z" };
      assert.equal(updateChatWindowDraft(db, cancelled, { state: "pending" }), 1);

      // 已取消的不能再被改回 pending
      const back = draft({ id: base.id, state: "pending" });
      assert.equal(updateChatWindowDraft(db, back, { state: "pending" }), 0);

      // 内容 hash 变了（秘书刚写完）时，基于旧 hash 的编辑不能覆盖
      const another = draft();
      insertChatWindowDraft(db, another);
      const agentVersion = { ...another, content: "秘书写的", contentHash: "a".repeat(64), contentBy: "agent" as const, updatedAt: "2026-11-03T00:00:02.000Z" };
      assert.equal(updateChatWindowDraft(db, agentVersion, { state: "pending", contentHash: null }), 1);
      const humanEdit = { ...another, content: "我改的", contentHash: "b".repeat(64), contentBy: "human" as const, updatedAt: "2026-11-03T00:00:03.000Z" };
      assert.equal(updateChatWindowDraft(db, humanEdit, { state: "pending", contentHash: null }), 0);
    } finally {
      db.close();
    }
  });
});
