import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { openDatabase, type SqliteDatabase } from "../src/database";
import {
  getProjectNote,
  insertProjectNote,
  latestProjectNote,
  listLatestProjectNotes,
  listProjectNoteHistory,
} from "../src/notes";
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

const NOW = "2026-11-02T00:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const SCOPE = { kind: "conversation" as const, conversationId: "conv_" + "0".repeat(26) };
const note = (n: number, patch: Record<string, unknown> = {}) => ({
  id: "note_" + ulid(),
  scope: SCOPE,
  agent: "deepseek",
  version: n,
  parentId: null as string | null,
  content: "第 " + n + " 版",
  contentHash: sha("第 " + n + " 版"),
  updatedBy: "agent" as const,
  reason: "reply" as const,
  source: { kind: "chat_run" as const, runId: "run_" + ulid() },
  revertedFromId: null,
  shrankALot: false,
  createdAt: NOW,
  ...patch,
});

function fresh(): SqliteDatabase {
  const dir = mkdtempSync(join(tmpdir(), "room-notes-"));
  dirs.push(dir);
  return openDatabase(join(dir, "test.db"));
}

describe("project notes storage (C-46 / D-46a)", () => {
  it("stores a version chain, reads the latest and the history", () => {
    const db = fresh();
    try {
      const first = note(1);
      insertProjectNote(db, first as never);
      const second = note(2, { parentId: first.id, content: "第 2 版", contentHash: sha("第 2 版") });
      insertProjectNote(db, second as never);

      assert.equal(latestProjectNote(db, SCOPE, "deepseek")?.id, second.id);
      assert.deepEqual(listLatestProjectNotes(db, SCOPE).map((n) => n.id), [second.id]);
      assert.deepEqual(listProjectNoteHistory(db, SCOPE, "deepseek").map((n) => n.version), [2, 1]);
      assert.equal(getProjectNote(db, first.id)?.content, "第 1 版");
    } finally {
      db.close();
    }
  });

  it("refuses a broken version chain", () => {
    const db = fresh();
    try {
      const first = note(1);
      insertProjectNote(db, first as never);
      assert.throws(
        () => insertProjectNote(db, note(3, { parentId: first.id }) as never),
        /next version/,
      );
      assert.throws(
        () => insertProjectNote(db, note(2, { parentId: "note_" + ulid() }) as never),
        /next version/,
      );
    } finally {
      db.close();
    }
  });

  it("notes are immutable: UPDATE and DELETE are rejected", () => {
    const db = fresh();
    try {
      const first = note(1);
      insertProjectNote(db, first as never);
      assert.throws(() => db.prepare("UPDATE project_notes SET content = 'x' WHERE id = ?").run(first.id), /immutable/);
      assert.throws(() => db.prepare("DELETE FROM project_notes WHERE id = ?").run(first.id), /immutable/);
    } finally {
      db.close();
    }
  });

  it("keeps one latest per agent in the same scope", () => {
    const db = fresh();
    try {
      insertProjectNote(db, note(1) as never);
      insertProjectNote(db, note(1, { agent: "codex" }) as never);
      assert.deepEqual(listLatestProjectNotes(db, SCOPE).map((n) => n.agent), ["codex", "deepseek"]);
    } finally {
      db.close();
    }
  });
});
