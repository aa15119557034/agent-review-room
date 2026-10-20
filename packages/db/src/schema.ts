import {
  AgentEvent,
  ApprovalState,
  ContributionType,
  FailureReason,
  RunState,
  RunSubstate,
  TERMINAL_EVENT_TYPES,
} from "@room/schemas";

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
/**
 * AgentEvent 的全部 type 字面量。直接从契约的 discriminated union 取，
 * 不手抄——契约加一个事件类型，这里的 CHECK 自动跟着变。
 */
const AGENT_EVENT_TYPES = (
  AgentEvent.options as unknown as { shape: { type: { value: string } } }[]
).map((option) => option.shape.type.value);

/** AgentName 契约：^[a-z0-9][a-z0-9-]{0,63}$ */
const AGENT_NAME_CHECK = "CHECK (length(source_agent) BETWEEN 1 AND 64 AND source_agent NOT GLOB '*[^a-z0-9-]*')";
const REVIEWER_AGENT_CHECK =
  "CHECK (length(reviewer_agent) BETWEEN 1 AND 64 AND reviewer_agent NOT GLOB '*[^a-z0-9-]*')";
/** Sha256Hex 契约：64 位小写 hex */
const SHA256_CHECK = (column: string): string =>
  `CHECK (length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*')`;

/** runs 表的列与约束（v1 与 v2 共用）。用模板字符串保留 ${...} 插值。 */
const RUNS_COLUMNS = `  id              TEXT NOT NULL PRIMARY KEY,
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
  CHECK (failure_reason IS NULL OR state = 'FAILED')`;

/** runs 的两个触发器（表重建后必须重新挂上） */
const RUNS_TRIGGERS = "CREATE TRIGGER runs_must_match_approved_approval BEFORE INSERT ON runs\nWHEN NOT EXISTS (\n  SELECT 1 FROM approvals a\n  WHERE a.id = NEW.approval_id\n    AND a.snapshot_id = NEW.snapshot_id\n    AND a.project_id = NEW.project_id\n    AND a.state = 'APPROVED'\n)\nBEGIN\n  SELECT RAISE(ABORT, 'run must match an APPROVED approval of the same snapshot');\nEND;\n\n-- Run 的身份字段不可改：否则可以把已存在的 Run 改挂到别的 snapshot / approval 上\nCREATE TRIGGER runs_identity_is_immutable\nBEFORE UPDATE OF approval_id, snapshot_id, project_id ON runs\nWHEN NEW.approval_id IS NOT OLD.approval_id\n  OR NEW.snapshot_id IS NOT OLD.snapshot_id\n  OR NEW.project_id IS NOT OLD.project_id\nBEGIN\n  SELECT RAISE(ABORT, 'run identity is immutable');\nEND;";

/**
 * v2：failure_reason 的 CHECK 在 v1 时由枚举生成；契约新增 incomplete_output 后，
 * 已经建好的数据库不认识新值。SQLite 不能修改 CHECK，只能重建表：
 * 建新表 → 拷数据 → 删旧表 → 改名 → 重建索引与触发器。
 * 外键在此期间关闭（由 runMigrations 负责），否则 DROP TABLE runs 会被引用挡住。
 */
export const SCHEMA_V2 = [
  "CREATE TABLE runs_v2 (\n" + RUNS_COLUMNS + "\n) STRICT;",
  "INSERT INTO runs_v2 (id, project_id, approval_id, snapshot_id, adapter_id, state, substate, failure_reason, created_at, started_at, finished_at)",
  "SELECT id, project_id, approval_id, snapshot_id, adapter_id, state, substate, failure_reason, created_at, started_at, finished_at FROM runs;",
  "DROP TABLE runs;",
  "ALTER TABLE runs_v2 RENAME TO runs;",
  "CREATE INDEX idx_runs_project_created ON runs(project_id, created_at);",
  "CREATE INDEX idx_runs_state ON runs(state) WHERE state IN ('QUEUED', 'STARTING', 'RUNNING');",
  RUNS_TRIGGERS,
].join("\n");

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
${RUNS_COLUMNS}
) STRICT;

-- ---------------------------------------------------------------- Run 事件（只追加）
CREATE TABLE run_events (
  run_id    TEXT    NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  seq       INTEGER NOT NULL CHECK (seq >= 0),
  event_id  TEXT    NOT NULL UNIQUE,
  type      TEXT    NOT NULL ${inCheck("type", AGENT_EVENT_TYPES)},
  -- 完整 AgentEvent 的 JSON（含 type/seq/ts 之外的字段）
  payload   TEXT    NOT NULL CHECK (json_valid(payload)),
  ts        TEXT    NOT NULL,
  PRIMARY KEY (run_id, seq)
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
-- AC-9 的数据库级保证：每个 run 最多一个终止事件
CREATE UNIQUE INDEX ux_run_events_terminal ON run_events(run_id)
  WHERE type IN (${quoted(TERMINAL_EVENT_TYPES as unknown as string[])});

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

CREATE TRIGGER contributions_no_update BEFORE UPDATE ON contributions
BEGIN
  SELECT RAISE(ABORT, 'contributions are immutable');
END;

CREATE TRIGGER contributions_no_delete BEFORE DELETE ON contributions
BEGIN
  SELECT RAISE(ABORT, 'contributions are immutable');
END;

-- 事件只追加：run_events 是 run 的完整回放记录，不允许改写
CREATE TRIGGER run_events_no_update BEFORE UPDATE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run_events are append-only');
END;

CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run_events are append-only');
END;

-- 核心承诺（AC-7）：Run 必须对应「批准了同一份 snapshot」的 Approval。
-- 「消费 Approval」和「创建 Run」必须同事务，且 Approval 先变成 APPROVED。
${RUNS_TRIGGERS}

-- 跨表一致性：Contribution 必须属于来源 message 的同一个项目
CREATE TRIGGER contributions_project_matches_message BEFORE INSERT ON contributions
WHEN (SELECT project_id FROM messages WHERE id = NEW.source_message_id) IS NOT NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'contribution project must match its source message');
END;

-- 跨表一致性：Approval 必须属于其 snapshot 的同一个项目
CREATE TRIGGER approvals_project_matches_snapshot BEFORE INSERT ON approvals
WHEN (SELECT project_id FROM prompt_snapshots WHERE id = NEW.snapshot_id) IS NOT NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'approval project must match its snapshot');
END;
`;