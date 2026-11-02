/**
 * 迁移 v21（C-46 / ADR-005 §4，D-46b）：聊天的「换窗口」。
 *
 * - chat_window_drafts：正在准备的换窗口（草稿）。内容由写交接的 Run 或用户写，点「换」才变成窗口。
 * - chat_windows：换过的窗口，**不可变**（和项目笔记一样用触发器拦 UPDATE / DELETE）。
 *   index 从 2 开始（第 1 个窗口不写记录），UNIQUE 保证同一会话、同一位秘书的窗口编号不重复。
 *
 * starts_after_message_id 指向 prepare 那一刻的最后一条消息；聊天消息只撤回不删除，所以这条永远有效。
 */
export const SCHEMA_V21 = `

-- D-46b：chat_snapshots / chat_runs 的 purpose 要收下 window_handoff。SQLite 改不了 CHECK，只能重建。
-- 重建期间关外键（迁移里 disableForeignKeys），迁完由迁移自己 foreign_key_check。

CREATE TABLE chat_snapshots_v21 (
  id                    TEXT NOT NULL PRIMARY KEY,
  purpose               TEXT NOT NULL CHECK (purpose IN ('reply', 'history_summary', 'window_handoff')),
  conversation_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
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
  image_slot            TEXT,
  project_note_id       TEXT,
  CHECK ((purpose = 'reply') = (user_message_id IS NOT NULL))
) STRICT;

INSERT INTO chat_snapshots_v21 (
  id, purpose, conversation_id, user_message_id, agent, content, content_hash, nonce, memory_slot, attachments,
  included_message_ids, included_summary_ids, adapter_version, token_estimate, created_at, image_slot, project_note_id
)
SELECT id, purpose, conversation_id, user_message_id, agent, content, content_hash, nonce, memory_slot, attachments,
  included_message_ids, included_summary_ids, adapter_version, token_estimate, created_at, image_slot, project_note_id
FROM chat_snapshots;

DROP TABLE chat_snapshots;
ALTER TABLE chat_snapshots_v21 RENAME TO chat_snapshots;

CREATE INDEX idx_chat_snapshots_conversation ON chat_snapshots(conversation_id, created_at);

CREATE TRIGGER chat_snapshots_no_update BEFORE UPDATE ON chat_snapshots
BEGIN
  SELECT RAISE(ABORT, 'chat snapshots are immutable');
END;

CREATE TRIGGER chat_snapshots_no_delete BEFORE DELETE ON chat_snapshots
BEGIN
  SELECT RAISE(ABORT, 'chat snapshots are immutable');
END;

CREATE TABLE chat_runs_v21 (
  id                TEXT NOT NULL PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind = 'chat'),
  purpose           TEXT NOT NULL CHECK (purpose IN ('reply', 'history_summary', 'window_handoff')),
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
  attempt           INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  CHECK ((purpose = 'reply') = (slot_id IS NOT NULL)),
  CHECK ((state = 'RUNNING') = (substate IS NOT NULL)),
  CHECK ((state = 'FAILED') = (failure_reason IS NOT NULL)),
  UNIQUE (slot_id, attempt)
) STRICT;

INSERT INTO chat_runs_v21 (
  id, kind, purpose, conversation_id, slot_id, agent, snapshot_id, snapshot_hash, final_prompt_hash,
  memory_manifest, model, adapter_id, state, substate, failure_reason, attempt, created_at, started_at, finished_at
)
SELECT id, kind, purpose, conversation_id, slot_id, agent, snapshot_id, snapshot_hash, final_prompt_hash,
  memory_manifest, model, adapter_id, state, substate, failure_reason, attempt, created_at, started_at, finished_at
FROM chat_runs;

DROP TABLE chat_runs;
ALTER TABLE chat_runs_v21 RENAME TO chat_runs;

CREATE INDEX idx_chat_runs_slot ON chat_runs(slot_id, attempt);
CREATE INDEX idx_chat_runs_conversation ON chat_runs(conversation_id, created_at);
CREATE INDEX idx_chat_runs_active ON chat_runs(state) WHERE state IN ('QUEUED', 'STARTING', 'RUNNING');

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

CREATE TABLE chat_window_drafts (
  id                      TEXT NOT NULL PRIMARY KEY,
  conversation_id         TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent                   TEXT NOT NULL,
  starts_after_message_id TEXT NOT NULL REFERENCES chat_messages(id),
  run_id                  TEXT,
  content                 TEXT CHECK (content IS NULL OR length(content) <= 20000),
  content_hash            TEXT,
  content_by              TEXT CHECK (content_by IN ('agent', 'human') OR content_by IS NULL),
  state                   TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'cancelled')),
  window_id               TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  CHECK ((content IS NULL) = (content_hash IS NULL)),
  CHECK ((content IS NULL) = (content_by IS NULL)),
  CHECK (content_hash IS NULL OR (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'))
) STRICT;

-- 同一 (会话, 秘书) 最多一份 pending：双击 / 并发也只留一份
CREATE UNIQUE INDEX ux_chat_window_drafts_pending ON chat_window_drafts(conversation_id, agent) WHERE state = 'pending';
CREATE INDEX idx_chat_window_drafts_lookup ON chat_window_drafts(conversation_id, agent, state);

CREATE TABLE chat_windows (
  id                      TEXT NOT NULL PRIMARY KEY,
  conversation_id         TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent                   TEXT NOT NULL,
  idx                     INTEGER NOT NULL CHECK (idx >= 2),
  starts_after_message_id TEXT NOT NULL REFERENCES chat_messages(id),
  handoff_note_id         TEXT NOT NULL REFERENCES project_notes(id),
  draft_id                TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  UNIQUE (conversation_id, agent, idx)
) STRICT;

CREATE INDEX idx_chat_windows_member ON chat_windows(conversation_id, agent, idx DESC);

CREATE TRIGGER chat_windows_no_update BEFORE UPDATE ON chat_windows
BEGIN
  SELECT RAISE(ABORT, 'chat windows are immutable');
END;

CREATE TRIGGER chat_windows_no_delete BEFORE DELETE ON chat_windows
BEGIN
  SELECT RAISE(ABORT, 'chat windows are immutable');
END;
`;
