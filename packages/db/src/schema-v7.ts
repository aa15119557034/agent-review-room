/**
 * 迁移 v7（C-34 / D-31c）：一键转议题。
 *
 * messages 加一种 kind：'chat_material'（从聊天转来的初始材料），以及两列：
 * - conversation_id：来源会话
 * - chat_message_ids：选中的聊天消息 id（JSON 数组，1～200 条）
 *
 * 必须重建表：SQLite 改不了 CHECK，v3 的 kind 是写死的字面量列表。
 * 重建时关外键（runMigrations 负责）；contributions 上引用 messages 的触发器先摘掉、重建后装回。
 */
export const SCHEMA_V7 = `
DROP TRIGGER IF EXISTS contributions_project_matches_message;

CREATE TABLE messages_v7 (
  id               TEXT NOT NULL PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'source_input', 'reviewer_output', 'human_note', 'agent_reply', 'summary', 'chat_material')),
  source_agent     TEXT CHECK (source_agent IS NULL OR (
                     length(source_agent) BETWEEN 1 AND 64 AND source_agent NOT GLOB '*[^a-z0-9-]*')),
  run_id           TEXT REFERENCES runs(id) ON DELETE RESTRICT,
  round_id         TEXT,
  turn_id          TEXT,
  on_behalf_of     TEXT,
  -- chat_material 专用：来源会话 + 选中的聊天消息 id（JSON 数组）
  conversation_id  TEXT REFERENCES conversations(id) ON DELETE RESTRICT,
  chat_message_ids TEXT CHECK (
                     chat_message_ids IS NULL OR
                     (json_valid(chat_message_ids) AND json_array_length(chat_message_ids) BETWEEN 1 AND 200)),
  content          TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 2000000),
  created_at       TEXT NOT NULL,
  CHECK (
    (kind = 'source_input' AND source_agent IS NOT NULL AND run_id IS NULL
       AND round_id IS NULL AND turn_id IS NULL
       AND conversation_id IS NULL AND chat_message_ids IS NULL) OR
    (kind = 'reviewer_output' AND source_agent IS NOT NULL AND run_id IS NOT NULL
       AND round_id IS NULL AND turn_id IS NULL
       AND conversation_id IS NULL AND chat_message_ids IS NULL) OR
    (kind = 'human_note' AND source_agent IS NULL AND run_id IS NULL AND turn_id IS NULL
       AND conversation_id IS NULL AND chat_message_ids IS NULL) OR
    (kind IN ('agent_reply', 'summary') AND source_agent IS NOT NULL
       AND run_id IS NOT NULL AND round_id IS NOT NULL AND turn_id IS NOT NULL
       AND conversation_id IS NULL AND chat_message_ids IS NULL) OR
    (kind = 'chat_material' AND source_agent IS NULL AND run_id IS NULL AND round_id IS NULL
       AND turn_id IS NULL AND on_behalf_of IS NULL
       AND conversation_id IS NOT NULL AND chat_message_ids IS NOT NULL)
  ),
  CHECK (on_behalf_of IS NULL OR kind = 'agent_reply')
) STRICT;

INSERT INTO messages_v7 (id, project_id, kind, source_agent, run_id, round_id, turn_id, on_behalf_of, conversation_id,
                         chat_message_ids, content, created_at)
SELECT id, project_id, kind, source_agent, run_id, round_id, turn_id, on_behalf_of, NULL, NULL, content, created_at
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_v7 RENAME TO messages;

CREATE INDEX idx_messages_project_created ON messages(project_id, created_at);
CREATE INDEX idx_messages_run ON messages(run_id) WHERE run_id IS NOT NULL;

CREATE TRIGGER messages_no_update BEFORE UPDATE ON messages
BEGIN
  SELECT RAISE(ABORT, 'messages are immutable');
END;

CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages
BEGIN
  SELECT RAISE(ABORT, 'messages are immutable');
END;

CREATE TRIGGER contributions_project_matches_message BEFORE INSERT ON contributions
WHEN (SELECT project_id FROM messages WHERE id = NEW.source_message_id) IS NOT NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'contribution project must match its source message');
END;
`;
