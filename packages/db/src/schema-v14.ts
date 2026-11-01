/**
 * 迁移 v14（X-30 / D-41）：聊天历史摘要。
 *
 * 和讨论室的 RoundSummary 一样：本会话较早的历史压成摘要，最近的仍然全文。
 * 契约（C-34）里 `ChatHistorySummary` 早就定了形状，这一版才落地存哪儿：
 *
 * - `source_message_ids`：这条摘要覆盖了哪些消息（JSON 数组）。其中任何一条被撤回，
 *   摘要在**同一个事务**里变成 `stale`，下次发送前重建；`stale` 的摘要不再进任何 Snapshot
 * - `run_id` 指向写这条摘要的聊天 Run（`purpose = 'history_summary'`），和契约的 `runId` 一致
 * - 摘要也是不可信资料：拼 Prompt 时由 core 用 nonce 边界包起来，这里只存正文
 */
export const SCHEMA_V14 = `
CREATE TABLE chat_summaries (
  id                 TEXT NOT NULL PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  -- 覆盖了哪些消息：至少一条，撤回时按这个把摘要标 stale
  source_message_ids TEXT NOT NULL CHECK (
                       json_valid(source_message_ids) AND json_array_length(source_message_ids) >= 1
                     ),
  content            TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 200000),
  content_hash       TEXT NOT NULL CHECK (
                       length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
                     ),
  state              TEXT NOT NULL CHECK (state IN ('current', 'stale')),
  -- 写这条摘要的聊天 Run（purpose = 'history_summary'）
  run_id             TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE RESTRICT,
  agent              TEXT NOT NULL CHECK (
                       length(agent) BETWEEN 1 AND 64 AND agent NOT GLOB '*[^a-z0-9-]*'
                     ),
  created_at         TEXT NOT NULL
) STRICT;

CREATE INDEX idx_chat_summaries_conversation ON chat_summaries(conversation_id, created_at, id);
`;
