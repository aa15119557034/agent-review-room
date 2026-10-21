/**
 * 迁移 v3：讨论室（ADR-002 / C-20）。
 *
 * 两条原则：
 * 1. 从 v3 起，CHECK 里的枚举一律写死成字面量——v1/v2 是运行时从契约生成的，会随契约漂移；
 *    迁移必须是写死的历史事实，否则「同一个版本号在不同时间建出不同的库」。
 * 2. 重建 messages / runs 时关外键（由 runMigrations 负责），否则 DROP TABLE 会被引用挡住。
 */

export const SCHEMA_V3 = `
-- ================================================================ 节点与参与者
CREATE TABLE nodes (
  id           TEXT NOT NULL PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  base_url     TEXT,
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE agents (
  id             TEXT NOT NULL PRIMARY KEY,
  display_name   TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 40),
  color          TEXT NOT NULL CHECK (color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  avatar_ref     TEXT,
  role_note      TEXT NOT NULL DEFAULT '' CHECK (length(role_note) <= 2000),
  can_discuss    INTEGER NOT NULL DEFAULT 1 CHECK (can_discuss IN (0, 1)),
  can_summarize  INTEGER NOT NULL DEFAULT 0 CHECK (can_summarize IN (0, 1)),
  can_execute    INTEGER NOT NULL DEFAULT 0 CHECK (can_execute IN (0, 1)),
  node_id        TEXT REFERENCES nodes(id) ON DELETE RESTRICT,
  profile_id     TEXT,
  paused_by_user INTEGER NOT NULL DEFAULT 0 CHECK (paused_by_user IN (0, 1)),
  substitute     TEXT REFERENCES agents(id) ON DELETE RESTRICT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (substitute IS NULL OR substitute <> id)
) STRICT;

-- ================================================================ 方案版本
CREATE TABLE plan_versions (
  id                 TEXT NOT NULL PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  version            INTEGER NOT NULL CHECK (version >= 1),
  state              TEXT NOT NULL CHECK (state IN ('DRAFT', 'CURRENT', 'FINAL', 'SUPERSEDED')),
  content            TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 200000),
  content_hash       TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  change_note        TEXT NOT NULL DEFAULT '' CHECK (length(change_note) <= 2000),
  based_on_round_id  TEXT,
  parent_id          TEXT REFERENCES plan_versions(id) ON DELETE RESTRICT,
  drafted_by_kind    TEXT NOT NULL CHECK (drafted_by_kind IN ('human', 'agent')),
  drafted_by_agent   TEXT,
  superseded_reason  TEXT CHECK (superseded_reason IS NULL OR length(superseded_reason) <= 2000),
  created_at         TEXT NOT NULL,
  decided_at         TEXT,
  UNIQUE (project_id, version),
  CHECK ((drafted_by_kind = 'agent') = (drafted_by_agent IS NOT NULL)),
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;

CREATE UNIQUE INDEX ux_plan_current ON plan_versions(project_id) WHERE state = 'CURRENT';
CREATE UNIQUE INDEX ux_plan_final ON plan_versions(project_id) WHERE state = 'FINAL';

-- ================================================================ 轮
CREATE TABLE rounds (
  id              TEXT NOT NULL PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  round_index     INTEGER NOT NULL CHECK (round_index >= 1),
  state           TEXT NOT NULL CHECK (state IN ('DRAFT', 'RUNNING', 'PAUSED', 'AWAITING_SUMMARY', 'SUMMARIZING', 'SUMMARIZED', 'VOIDED')),
  task            TEXT NOT NULL CHECK (length(task) BETWEEN 1 AND 20000),
  task_source     TEXT NOT NULL CHECK (task_source IN ('human', 'summarizer_proposal', 'carried_over')),
  recipients      TEXT NOT NULL CHECK (json_valid(recipients) AND json_array_length(recipients) BETWEEN 1 AND 8),
  plan_version_id TEXT REFERENCES plan_versions(id) ON DELETE RESTRICT,
  history_mode    TEXT NOT NULL CHECK (history_mode IN ('recent_with_summaries', 'full')),
  void_reason     TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 2000),
  active_ms       INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  UNIQUE (project_id, round_index),
  CHECK (state <> 'VOIDED' OR void_reason IS NOT NULL)
) STRICT;

-- ================================================================ 一批（一次盖章）
CREATE TABLE batches (
  id                TEXT NOT NULL PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  round_id          TEXT NOT NULL REFERENCES rounds(id) ON DELETE RESTRICT,
  kind              TEXT NOT NULL CHECK (kind IN ('initial', 'supplement', 'resume', 'retry', 'summary')),
  state             TEXT NOT NULL CHECK (state IN ('DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  compressed_rounds TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(compressed_rounds)),
  decided_via       TEXT CHECK (decided_via IS NULL OR decided_via IN ('desktop', 'mobile')),
  created_at        TEXT NOT NULL,
  decided_at        TEXT
) STRICT;

CREATE TABLE batch_items (
  batch_id            TEXT NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  recipient           TEXT NOT NULL,
  on_behalf_of        TEXT,
  approval_id         TEXT NOT NULL UNIQUE REFERENCES approvals(id) ON DELETE RESTRICT,
  snapshot_id         TEXT NOT NULL REFERENCES prompt_snapshots(id) ON DELETE RESTRICT,
  content_hash        TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  differs_from_others INTEGER NOT NULL DEFAULT 0 CHECK (differs_from_others IN (0, 1)),
  token_estimate      INTEGER NOT NULL DEFAULT 0 CHECK (token_estimate >= 0),
  PRIMARY KEY (batch_id, recipient),
  CHECK (on_behalf_of IS NULL OR on_behalf_of <> recipient)
) STRICT;

-- ================================================================ 发言（Turn）
CREATE TABLE turns (
  id               TEXT NOT NULL PRIMARY KEY,
  round_id         TEXT NOT NULL REFERENCES rounds(id) ON DELETE RESTRICT,
  batch_id         TEXT NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  agent            TEXT NOT NULL,
  on_behalf_of     TEXT,
  is_summary       INTEGER NOT NULL DEFAULT 0 CHECK (is_summary IN (0, 1)),
  approval_id      TEXT NOT NULL UNIQUE REFERENCES approvals(id) ON DELETE RESTRICT,
  run_id           TEXT UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
  outcome          TEXT NOT NULL CHECK (outcome IN (
                     'pending', 'running', 'answered', 'interrupted', 'round_ended',
                     'paused', 'absent_quota', 'timed_out', 'failed', 'rejected')),
  partial_text     TEXT CHECK (partial_text IS NULL OR length(partial_text) <= 2000000),
  reply_message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT,
  superseded_by    TEXT REFERENCES turns(id) ON DELETE RESTRICT,
  created_at       TEXT NOT NULL,
  finished_at      TEXT,
  CHECK (superseded_by IS NULL OR superseded_by <> id),
  CHECK ((outcome = 'answered') = (reply_message_id IS NOT NULL))
) STRICT;

-- ================================================================ 汇总
CREATE TABLE round_summaries (
  round_id        TEXT NOT NULL PRIMARY KEY REFERENCES rounds(id) ON DELETE RESTRICT,
  message_id      TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
  summarizer      TEXT NOT NULL,
  answered        INTEGER NOT NULL CHECK (answered >= 0),
  expected        INTEGER NOT NULL CHECK (expected >= 1),
  report          TEXT CHECK (report IS NULL OR json_valid(report)),
  plan_version_id TEXT REFERENCES plan_versions(id) ON DELETE RESTRICT,
  created_at      TEXT NOT NULL,
  CHECK (answered <= expected)
) STRICT;

CREATE INDEX idx_rounds_project ON rounds(project_id, round_index);
CREATE INDEX idx_batches_round ON batches(round_id);
CREATE INDEX idx_turns_round ON turns(round_id);
CREATE INDEX idx_turns_batch ON turns(batch_id);
CREATE INDEX idx_plans_project ON plan_versions(project_id, version);
`;

/** 重建 messages 与 runs：新增的枚举写死成字面量，同时给 messages 加讨论室需要的列 */
export const SCHEMA_V3_REBUILD = `
-- ================================================================ 重建 messages（新增讨论室三种 kind + 新列）
-- contributions 上有触发器 SELECT messages，DROP TABLE 时会被它挡住，先摘掉、重建后再装回
DROP TRIGGER IF EXISTS contributions_project_matches_message;

CREATE TABLE messages_v3 (
  id           TEXT NOT NULL PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  kind         TEXT NOT NULL CHECK (kind IN ('source_input', 'reviewer_output', 'human_note', 'agent_reply', 'summary')),
  source_agent TEXT CHECK (source_agent IS NULL OR (
                 length(source_agent) BETWEEN 1 AND 64 AND source_agent NOT GLOB '*[^a-z0-9-]*')),
  run_id       TEXT REFERENCES runs(id) ON DELETE RESTRICT,
  round_id     TEXT,
  turn_id      TEXT,
  on_behalf_of TEXT,
  content      TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 2000000),
  created_at   TEXT NOT NULL,
  CHECK (
    (kind = 'source_input'  AND source_agent IS NOT NULL AND run_id IS NULL AND round_id IS NULL AND turn_id IS NULL) OR
    (kind = 'reviewer_output' AND source_agent IS NOT NULL AND run_id IS NOT NULL AND round_id IS NULL AND turn_id IS NULL) OR
    (kind = 'human_note'    AND source_agent IS NULL AND run_id IS NULL AND turn_id IS NULL) OR
    (kind IN ('agent_reply', 'summary') AND source_agent IS NOT NULL
       AND run_id IS NOT NULL AND round_id IS NOT NULL AND turn_id IS NOT NULL)
  ),
  CHECK (on_behalf_of IS NULL OR kind = 'agent_reply')
) STRICT;

INSERT INTO messages_v3 (id, project_id, kind, source_agent, run_id, round_id, turn_id, on_behalf_of, content, created_at)
SELECT id, project_id, kind, source_agent, run_id, NULL, NULL, NULL, content, created_at FROM messages;

DROP TABLE messages;
ALTER TABLE messages_v3 RENAME TO messages;

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

-- ================================================================ 重建 runs（failure_reason 写死字面量）
CREATE TABLE runs_v3 (
  id              TEXT NOT NULL PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  approval_id     TEXT NOT NULL UNIQUE REFERENCES approvals(id) ON DELETE RESTRICT,
  snapshot_id     TEXT NOT NULL REFERENCES prompt_snapshots(id) ON DELETE RESTRICT,
  adapter_id      TEXT NOT NULL CHECK (length(adapter_id) >= 1),
  state           TEXT NOT NULL CHECK (state IN ('QUEUED', 'STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT')),
  substate        TEXT CHECK (substate IS NULL OR substate IN ('active', 'waiting_for_human', 'disconnected')),
  failure_reason  TEXT CHECK (failure_reason IS NULL OR failure_reason IN (
                    'interrupted', 'connection_lost', 'lease_expired', 'remote_lost', 'remote_rejected',
                    'hash_mismatch', 'commit_mismatch', 'spawn_failed', 'process_exit_nonzero',
                    'output_limit_exceeded', 'incomplete_output', 'postprocess', 'quota_exhausted', 'internal')),
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  CHECK (substate IS NULL OR state = 'RUNNING'),
  CHECK (failure_reason IS NULL OR state = 'FAILED')
) STRICT;

INSERT INTO runs_v3 (id, project_id, approval_id, snapshot_id, adapter_id, state, substate, failure_reason, created_at, started_at, finished_at)
SELECT id, project_id, approval_id, snapshot_id, adapter_id, state, substate, failure_reason, created_at, started_at, finished_at FROM runs;

DROP TABLE runs;
ALTER TABLE runs_v3 RENAME TO runs;

CREATE INDEX idx_runs_project_created ON runs(project_id, created_at);
CREATE INDEX idx_runs_state ON runs(state) WHERE state IN ('QUEUED', 'STARTING', 'RUNNING');

CREATE TRIGGER runs_must_match_approved_approval BEFORE INSERT ON runs
WHEN NOT EXISTS (
  SELECT 1 FROM approvals a
  WHERE a.id = NEW.approval_id
    AND a.snapshot_id = NEW.snapshot_id
    AND a.project_id = NEW.project_id
    AND a.state = 'APPROVED'
)
BEGIN
  SELECT RAISE(ABORT, 'run must match an APPROVED approval of the same snapshot');
END;

CREATE TRIGGER runs_identity_is_immutable
BEFORE UPDATE OF approval_id, snapshot_id, project_id ON runs
WHEN NEW.approval_id IS NOT OLD.approval_id
  OR NEW.snapshot_id IS NOT OLD.snapshot_id
  OR NEW.project_id IS NOT OLD.project_id
BEGIN
  SELECT RAISE(ABORT, 'run identity is immutable');
END;

-- ================================================================ 重建 prompt_snapshots（讨论室的 Snapshot 没有片段，contribution_ids 允许 []）
-- approvals 上有触发器 SELECT prompt_snapshots，同样要先摘掉
DROP TRIGGER IF EXISTS approvals_project_matches_snapshot;

CREATE TABLE prompt_snapshots_v3 (
  id                TEXT NOT NULL PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  content           TEXT NOT NULL CHECK (length(content) >= 1),
  content_hash      TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  nonce             TEXT NOT NULL CHECK (
                      length(nonce) BETWEEN 16 AND 64 AND nonce NOT GLOB '*[^0-9a-f]*'
                    ),
  contribution_ids  TEXT NOT NULL CHECK (
                      json_valid(contribution_ids) AND json_array_length(contribution_ids) >= 0
                    ),
  task_instruction  TEXT NOT NULL CHECK (length(task_instruction) BETWEEN 1 AND 20000),
  reviewer_agent    TEXT NOT NULL CHECK (
                      length(reviewer_agent) BETWEEN 1 AND 64 AND reviewer_agent NOT GLOB '*[^a-z0-9-]*'
                    ),
  adapter_version   TEXT NOT NULL CHECK (length(adapter_version) >= 1),
  token_estimate    INTEGER NOT NULL CHECK (token_estimate >= 0),
  synthesis_version INTEGER CHECK (synthesis_version IS NULL OR synthesis_version >= 0),
  branch            TEXT,
  commit_sha        TEXT CHECK (
                      commit_sha IS NULL OR (length(commit_sha) = 40 AND commit_sha NOT GLOB '*[^0-9a-f]*')
                    ),
  created_at        TEXT NOT NULL
) STRICT;

INSERT INTO prompt_snapshots_v3 (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction,
  reviewer_agent, adapter_version, token_estimate, synthesis_version, branch, commit_sha, created_at)
SELECT id, project_id, content, content_hash, nonce, contribution_ids, task_instruction,
  reviewer_agent, adapter_version, token_estimate, synthesis_version, branch, commit_sha, created_at
FROM prompt_snapshots;

DROP TABLE prompt_snapshots;
ALTER TABLE prompt_snapshots_v3 RENAME TO prompt_snapshots;

CREATE INDEX idx_snapshots_project_created ON prompt_snapshots(project_id, created_at);

CREATE TRIGGER prompt_snapshots_no_update BEFORE UPDATE ON prompt_snapshots
BEGIN
  SELECT RAISE(ABORT, 'prompt snapshots are immutable');
END;

CREATE TRIGGER prompt_snapshots_no_delete BEFORE DELETE ON prompt_snapshots
BEGIN
  SELECT RAISE(ABORT, 'prompt snapshots are immutable');
END;

CREATE TRIGGER approvals_project_matches_snapshot BEFORE INSERT ON approvals
WHEN (SELECT project_id FROM prompt_snapshots WHERE id = NEW.snapshot_id) IS NOT NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'approval project must match its snapshot');
END;

-- ================================================================ 一个议题同时只能有一轮没结束
CREATE UNIQUE INDEX ux_round_active ON rounds(project_id)
  WHERE state IN ('DRAFT', 'RUNNING', 'PAUSED', 'AWAITING_SUMMARY', 'SUMMARIZING');
`;
