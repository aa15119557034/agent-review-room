import { ApprovalState, ContributionType, FailureReason, RunState, RunSubstate } from "@room/schemas";

/**
 * Phase 0 表结构（D-02）。
 *
 * 设计原则：
 * 1. 枚举一律从 packages/schemas 的契约生成 CHECK，SQL 里不重复抄一遍枚举——
 *    契约改了这里跟着变，不会出现「代码允许、数据库拒绝」的漂移。
 * 2. 时间戳存 ISO 字符串（契约就是 IsoTimestamp），排序即 ULID 的字典序。
 * 3. STRICT 表：SQLite 3.37+ 的类型强校验，拼错类型当场报错而不是静默转换。
 * 4. 不可变的东西用 trigger 兜底：messages（V0.3 §17）与 prompt_snapshots（AC-4）。
 */

const quoted = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(", ");

/** 生成 `CHECK (column IN (...))` */
const inCheck = (column: string, values: readonly string[]): string =>
  `CHECK (${column} IN (${quoted(values)}))`;

const APPROVAL_STATES = ApprovalState.options;
const RUN_STATES = RunState.options;
const RUN_SUBSTATES = RunSubstate.options;
const FAILURE_REASONS = FailureReason.options;
const CONTRIBUTION_TYPES = ContributionType.options;

/** AgentName 契约：^[a-z0-9][a-z0-9-]{0,63}$ */
const AGENT_NAME_CHECK = "CHECK (length(source_agent) BETWEEN 1 AND 64 AND source_agent NOT GLOB '*[^a-z0-9-]*')";
const REVIEWER_AGENT_CHECK =
  "CHECK (length(reviewer_agent) BETWEEN 1 AND 64 AND reviewer_agent NOT GLOB '*[^a-z0-9-]*')";
/** Sha256Hex 契约：64 位小写 hex */
const SHA256_CHECK = (column: string): string =>
  `CHECK (length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*')`;

export const SCHEMA_V1 = `
-- ---------------------------------------------------------------- 项目
CREATE TABLE projects (
  id          TEXT NOT NULL PRIMARY KEY,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at  TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------- 原始消息（不可变）
CREATE TABLE messages (
  id            TEXT NOT NULL PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL CHECK (kind IN ('source_input', 'reviewer_output')),
  source_agent  TEXT NOT NULL ${AGENT_NAME_CHECK},
  run_id        TEXT REFERENCES runs(id) ON DELETE RESTRICT,
  content       TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 2000000),
  created_at    TEXT NOT NULL,
  -- 契约：reviewer_output 必须属于某个 run；source_input 不得挂 run
  CHECK (
    (kind = 'reviewer_output' AND run_id IS NOT NULL) OR
    (kind = 'source_input' AND run_id IS NULL)
  )
) STRICT;

-- ---------------------------------------------------------------- Contribution
CREATE TABLE contributions (
  id                 TEXT NOT NULL PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  type               TEXT NOT NULL ${inCheck("type", CONTRIBUTION_TYPES)},
  title              TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- 不变量：content === source.content.slice(start, end)，由后端截取写入
  content            TEXT NOT NULL CHECK (length(content) >= 1),
  selection_start    INTEGER NOT NULL CHECK (selection_start >= 0),
  selection_end      INTEGER NOT NULL CHECK (selection_end > selection_start),
  confidence         REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_by         TEXT NOT NULL CHECK (created_by IN ('human', 'agent', 'local_model')),
  schema_version     INTEGER NOT NULL CHECK (schema_version = 1),
  created_at         TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------- PromptSnapshot（不可变）
CREATE TABLE prompt_snapshots (
  id                TEXT NOT NULL PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  content           TEXT NOT NULL CHECK (length(content) >= 1),
  content_hash      TEXT NOT NULL ${SHA256_CHECK("content_hash")},
  nonce             TEXT NOT NULL CHECK (
                      length(nonce) BETWEEN 16 AND 64 AND nonce NOT GLOB '*[^0-9a-f]*'
                    ),
  contribution_ids  TEXT NOT NULL CHECK (
                      json_valid(contribution_ids) AND json_array_length(contribution_ids) >= 1
                    ),
  task_instruction  TEXT NOT NULL CHECK (length(task_instruction) BETWEEN 1 AND 20000),
  reviewer_agent    TEXT NOT NULL ${REVIEWER_AGENT_CHECK},
  adapter_version   TEXT NOT NULL CHECK (length(adapter_version) >= 1),
  token_estimate    INTEGER NOT NULL CHECK (token_estimate >= 0),
  synthesis_version INTEGER CHECK (synthesis_version IS NULL OR synthesis_version >= 0),
  branch            TEXT,
  commit_sha        TEXT CHECK (
                      commit_sha IS NULL OR (length(commit_sha) = 40 AND commit_sha NOT GLOB '*[^0-9a-f]*')
                    ),
  created_at        TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------- Approval
CREATE TABLE approvals (
  id           TEXT NOT NULL PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  snapshot_id  TEXT NOT NULL REFERENCES prompt_snapshots(id) ON DELETE RESTRICT,
  state        TEXT NOT NULL ${inCheck("state", APPROVAL_STATES)},
  decided_via  TEXT CHECK (decided_via IS NULL OR decided_via IN ('desktop', 'mobile')),
  reason       TEXT CHECK (reason IS NULL OR length(reason) <= 2000),
  created_at   TEXT NOT NULL,
  decided_at   TEXT
) STRICT;

-- ---------------------------------------------------------------- Run
CREATE TABLE runs (
  id              TEXT NOT NULL PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  -- 「一个 Approval 最多一个 Run」由唯一约束保证；消费 Approval + 建 Run 必须同事务
  approval_id     TEXT NOT NULL UNIQUE REFERENCES approvals(id) ON DELETE RESTRICT,
  snapshot_id     TEXT NOT NULL REFERENCES prompt_snapshots(id) ON DELETE RESTRICT,
  adapter_id      TEXT NOT NULL CHECK (length(adapter_id) >= 1),
  state           TEXT NOT NULL ${inCheck("state", RUN_STATES)},
  substate        TEXT CHECK (substate IS NULL OR substate IN (${quoted(RUN_SUBSTATES)})),
  failure_reason  TEXT CHECK (failure_reason IS NULL OR failure_reason IN (${quoted(FAILURE_REASONS)})),
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  -- 契约：substate 只在 RUNNING 时非 null；failureReason 只在 FAILED 时非 null
  CHECK (substate IS NULL OR state = 'RUNNING'),
  CHECK (failure_reason IS NULL OR state = 'FAILED')
) STRICT;

-- ---------------------------------------------------------------- 索引
CREATE INDEX idx_messages_project_created ON messages(project_id, created_at);
CREATE INDEX idx_messages_run ON messages(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_contributions_source ON contributions(source_message_id);
CREATE INDEX idx_contributions_project_created ON contributions(project_id, created_at);
CREATE INDEX idx_approvals_snapshot ON approvals(snapshot_id);
CREATE INDEX idx_runs_project_created ON runs(project_id, created_at);
CREATE INDEX idx_runs_state ON runs(state) WHERE state IN ('QUEUED', 'STARTING', 'RUNNING');
CREATE INDEX idx_snapshots_project_created ON prompt_snapshots(project_id, created_at);

-- ---------------------------------------------------------------- 不可变兜底
CREATE TRIGGER messages_no_update BEFORE UPDATE ON messages
BEGIN
  SELECT RAISE(ABORT, 'messages are immutable');
END;

CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages
BEGIN
  SELECT RAISE(ABORT, 'messages are immutable');
END;

CREATE TRIGGER prompt_snapshots_no_update BEFORE UPDATE ON prompt_snapshots
BEGIN
  SELECT RAISE(ABORT, 'prompt_snapshots are immutable');
END;

CREATE TRIGGER prompt_snapshots_no_delete BEFORE DELETE ON prompt_snapshots
BEGIN
  SELECT RAISE(ABORT, 'prompt_snapshots are immutable');
END;
`;
