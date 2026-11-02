/**
 * 迁移 v20（C-46 / ADR-005，D-46a）：项目笔记。
 *
 * 一版一行、不可变：同一 (scope, agent) 的 version 从 1 连续递增，parent_id 指上一版。
 * 回退 / 用户编辑 / 换窗口交接都是**新增一版**，不是改旧行——所以这里用触发器拦住 UPDATE / DELETE。
 * 来源（哪次回答、哪次换窗口 Run）存在 source_kind / source_id；两者一起有或一起没有（C-46 的 ProjectNote）。
 */
export const SCHEMA_V20 = `
CREATE TABLE project_notes (
  id               TEXT NOT NULL PRIMARY KEY,
  scope_kind       TEXT NOT NULL CHECK (scope_kind IN ('topic', 'conversation')),
  scope_id         TEXT NOT NULL,
  agent            TEXT NOT NULL,
  version          INTEGER NOT NULL CHECK (version >= 1),
  parent_id        TEXT,
  content          TEXT NOT NULL CHECK (length(content) <= 20000),
  content_hash     TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  updated_by       TEXT NOT NULL CHECK (updated_by IN ('agent', 'human')),
  reason           TEXT NOT NULL CHECK (reason IN ('reply', 'window_handoff', 'human_edit', 'revert')),
  source_kind      TEXT CHECK (source_kind IN ('turn', 'chat_run') OR source_kind IS NULL),
  source_id        TEXT,
  reverted_from_id TEXT,
  shrank_alot      INTEGER NOT NULL CHECK (shrank_alot IN (0, 1)),
  created_at       TEXT NOT NULL,
  UNIQUE (scope_kind, scope_id, agent, version),
  CHECK ((source_kind IS NULL) = (source_id IS NULL))
) STRICT;

CREATE INDEX idx_project_notes_version ON project_notes(scope_kind, scope_id, agent, version DESC);

CREATE TRIGGER project_notes_no_update BEFORE UPDATE ON project_notes
BEGIN
  SELECT RAISE(ABORT, 'project notes are immutable');
END;

CREATE TRIGGER project_notes_no_delete BEFORE DELETE ON project_notes
BEGIN
  SELECT RAISE(ABORT, 'project notes are immutable');
END;

-- Snapshot 记「这次带的是哪一版笔记」（ADR-005 §3）：NULL = 没有笔记 / C-46 之前拼的
ALTER TABLE prompt_snapshots ADD COLUMN project_note_id TEXT;
ALTER TABLE chat_snapshots ADD COLUMN project_note_id TEXT;
`;
