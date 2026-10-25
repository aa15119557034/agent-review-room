/**
 * 迁移 v6（C-34 / D-31b 第一段）：聊天的 Snapshot 和 Run。
 *
 * - chat_snapshots：主控端拼好的、不可变的一份 Prompt（含记忆槽位 marker、附件清单）
 * - chat_runs：聊天 Run（kind = "chat"），没有 Approval / project；一个回答位的一次尝试对应一行，
 *   UNIQUE (slot_id, attempt) 保证「连点两次重试只建一个 Run」
 *
 * 讨论室的 runs 表不动：它有 project_id / approval_id NOT NULL 和「必须匹配已批准的 approval」触发器，
 * 聊天 Run 没有这些字段（D-31a 的决定：分开建表，收尾和中断修复各自实现）。
 *
 * 仍然只加表、不加列；CHECK 里的枚举写死成字面量（迁移是历史事实）。
 */
export const SCHEMA_V6 = `
-- ================================================================ 聊天 Snapshot（不可变）
CREATE TABLE chat_snapshots (
  id                    TEXT NOT NULL PRIMARY KEY,
  purpose               TEXT NOT NULL CHECK (purpose IN ('reply', 'history_summary')),
  conversation_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  -- reply 一定是「回答某条消息」；history_summary 没有当前消息
  user_message_id       TEXT REFERENCES chat_messages(id) ON DELETE RESTRICT,
  agent                 TEXT NOT NULL CHECK (
                          length(agent) BETWEEN 1 AND 64 AND agent NOT GLOB '*[^a-z0-9-]*'
                        ),
  content               TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 2000000),
  content_hash          TEXT NOT NULL CHECK (
                          length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
                        ),
  nonce                 TEXT NOT NULL CHECK (
                          length(nonce) BETWEEN 16 AND 64 AND nonce NOT GLOB '*[^0-9a-f]*'
                        ),
  memory_slot           TEXT CHECK (memory_slot IS NULL OR json_valid(memory_slot)),
  -- C-42a：这次的图片清单；省略 = 没带图
  attachments           TEXT CHECK (attachments IS NULL OR json_valid(attachments)),
  included_message_ids  TEXT NOT NULL CHECK (
                          json_valid(included_message_ids) AND json_array_length(included_message_ids) >= 1
                        ),
  included_summary_ids  TEXT NOT NULL CHECK (
                          json_valid(included_summary_ids) AND json_array_length(included_summary_ids) >= 0
                        ),
  adapter_version       TEXT NOT NULL CHECK (length(adapter_version) >= 1),
  token_estimate        INTEGER NOT NULL CHECK (token_estimate >= 0),
  created_at            TEXT NOT NULL,
  CHECK ((purpose = 'reply') = (user_message_id IS NOT NULL))
) STRICT;

CREATE INDEX idx_chat_snapshots_conversation ON chat_snapshots(conversation_id, created_at);

CREATE TRIGGER chat_snapshots_no_update BEFORE UPDATE ON chat_snapshots
BEGIN
  SELECT RAISE(ABORT, 'chat snapshots are immutable');
END;

CREATE TRIGGER chat_snapshots_no_delete BEFORE DELETE ON chat_snapshots
BEGIN
  SELECT RAISE(ABORT, 'chat snapshots are immutable');
END;

-- ================================================================ 聊天 Run
CREATE TABLE chat_runs (
  id                TEXT NOT NULL PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind = 'chat'),
  purpose           TEXT NOT NULL CHECK (purpose IN ('reply', 'history_summary')),
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  slot_id           TEXT REFERENCES chat_reply_slots(id) ON DELETE RESTRICT,
  agent             TEXT NOT NULL CHECK (
                      length(agent) BETWEEN 1 AND 64 AND agent NOT GLOB '*[^a-z0-9-]*'
                    ),
  snapshot_id       TEXT NOT NULL REFERENCES chat_snapshots(id) ON DELETE RESTRICT,
  snapshot_hash     TEXT NOT NULL CHECK (
                      length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'
                    ),
  final_prompt_hash TEXT CHECK (
                      final_prompt_hash IS NULL OR
                      (length(final_prompt_hash) = 64 AND final_prompt_hash NOT GLOB '*[^0-9a-f]*')
                    ),
  memory_manifest   TEXT CHECK (memory_manifest IS NULL OR json_valid(memory_manifest)),
  model             TEXT CHECK (model IS NULL OR json_valid(model)),
  adapter_id        TEXT NOT NULL CHECK (length(adapter_id) >= 1),
  state             TEXT NOT NULL CHECK (state IN (
                      'QUEUED', 'STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')),
  substate          TEXT CHECK (substate IS NULL OR substate IN ('active', 'waiting_for_human', 'disconnected')),
  failure_reason    TEXT CHECK (failure_reason IS NULL OR failure_reason IN (
                      'interrupted', 'connection_lost', 'lease_expired', 'remote_lost', 'remote_rejected',
                      'hash_mismatch', 'commit_mismatch', 'spawn_failed', 'process_exit_nonzero',
                      'output_limit_exceeded', 'incomplete_output', 'postprocess', 'quota_exhausted', 'internal')),
  -- 第几次尝试（回答位的 attempt 同步）；history_summary 的 Run 恒为 1
  attempt           INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  CHECK ((purpose = 'reply') = (slot_id IS NOT NULL)),
  -- RUNNING ⇔ 有子状态、FAILED ⇔ 有失败原因（和契约 ChatRun 的 refine 一致）
  CHECK ((state = 'RUNNING') = (substate IS NOT NULL)),
  CHECK ((state = 'FAILED') = (failure_reason IS NOT NULL)),
  -- 同一个回答位的同一次尝试最多一个 Run（重试必须 attempt + 1）
  UNIQUE (slot_id, attempt)
) STRICT;

CREATE INDEX idx_chat_runs_slot ON chat_runs(slot_id, attempt);
CREATE INDEX idx_chat_runs_conversation ON chat_runs(conversation_id, created_at);
-- 中断修复：只扫还活着的
CREATE INDEX idx_chat_runs_active ON chat_runs(state) WHERE state IN ('QUEUED', 'STARTING', 'RUNNING');

-- Run 的身份字段不可改（否则可以把它改挂到别的回答位 / Snapshot 上）
CREATE TRIGGER chat_runs_identity_immutable
BEFORE UPDATE OF id, kind, purpose, conversation_id, slot_id, agent, snapshot_id, snapshot_hash, model, adapter_id,
  attempt, created_at ON chat_runs
WHEN NEW.id IS NOT OLD.id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.purpose IS NOT OLD.purpose
  OR NEW.conversation_id IS NOT OLD.conversation_id
  OR NEW.slot_id IS NOT OLD.slot_id
  OR NEW.agent IS NOT OLD.agent
  OR NEW.snapshot_id IS NOT OLD.snapshot_id
  OR NEW.snapshot_hash IS NOT OLD.snapshot_hash
  OR NEW.model IS NOT OLD.model
  OR NEW.adapter_id IS NOT OLD.adapter_id
  OR NEW.attempt IS NOT OLD.attempt
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'chat run identity is immutable');
END;

CREATE TRIGGER chat_runs_no_delete BEFORE DELETE ON chat_runs
BEGIN
  SELECT RAISE(ABORT, 'chat runs are never deleted');
END;
`;
