/**
 * 迁移 v5（C-34 / 1B-2）：聊天空间。
 *
 * - 三张新表：会话（conversations / conversation_members）、聊天消息（chat_messages）、回答位（chat_reply_slots）
 * - 两处新列（都可空，旧行 NULL，读的时候由 repository 补默认值）：
 *   projects.from_conversation_id、agents.chat_persona / chat_profile_id / memory_source
 * - 聊天 Run 和聊天 Snapshot 不在这里建：D-31b 的编排要一起定它们的写入路径，到时按自己的迁移加
 *   （所以 chat_messages.run_id / chat_reply_slots.run_id 现在是纯 TEXT，没有外键）
 *
 * 约定沿用 v3：CHECK 里的枚举写死成字面量（迁移是历史事实，不跟着契约漂移）。
 */
export const SCHEMA_V5 = `
-- ================================================================ 会话
CREATE TABLE conversations (
  id                   TEXT NOT NULL PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  -- 单聊记下对方是谁：一个 Agent 只能有一个单聊（部分唯一索引在下面）
  direct_agent         TEXT,
  -- 你起的名字（单聊相当于备注名）；NULL 时界面用成员名
  title                TEXT CHECK (title IS NULL OR length(title) BETWEEN 1 AND 60),
  pinned               INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  muted                INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  last_read_message_id TEXT REFERENCES chat_messages(id) ON DELETE RESTRICT,
  last_activity_at     TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  CHECK ((kind = 'direct') = (direct_agent IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX ux_conversations_direct ON conversations(direct_agent) WHERE direct_agent IS NOT NULL;
CREATE INDEX idx_conversations_activity ON conversations(pinned DESC, last_activity_at DESC);

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  agent           TEXT NOT NULL CHECK (length(agent) BETWEEN 1 AND 64 AND agent NOT GLOB '*[^a-z0-9-]*'),
  -- 成员顺序（界面按它显示，2～8 位）
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (conversation_id, agent),
  UNIQUE (conversation_id, ordinal)
) STRICT;

CREATE INDEX idx_conversation_members_agent ON conversation_members(agent);

-- ================================================================ 聊天消息（不可变，只有撤回改状态）
CREATE TABLE chat_messages (
  id                  TEXT NOT NULL PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  sender              TEXT NOT NULL CHECK (sender IN ('user', 'agent')),
  created_at          TEXT NOT NULL,

  -- 你发的消息
  content             TEXT CHECK (content IS NULL OR json_valid(content)),
  mentions            TEXT CHECK (mentions IS NULL OR json_valid(mentions)),
  quote_message_id    TEXT REFERENCES chat_messages(id) ON DELETE RESTRICT,
  replaces_message_id TEXT REFERENCES chat_messages(id) ON DELETE RESTRICT,
  state               TEXT CHECK (state IS NULL OR state IN ('sent', 'retracted')),
  retracted_at        TEXT,
  -- 防重复：chatSendIntentJson 的 sha256（D-31b 写；不是每条都有）
  request_hash        TEXT CHECK (
                        request_hash IS NULL OR
                        (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*')
                      ),

  -- 秘书的回答
  agent               TEXT CHECK (
                        agent IS NULL OR
                        (length(agent) BETWEEN 1 AND 64 AND agent NOT GLOB '*[^a-z0-9-]*')
                      ),
  text                TEXT CHECK (text IS NULL OR length(text) BETWEEN 1 AND 200000),
  in_reply_to         TEXT REFERENCES chat_messages(id) ON DELETE RESTRICT,
  slot_id             TEXT REFERENCES chat_reply_slots(id) ON DELETE RESTRICT,
  run_id              TEXT,
  memory_entries_used INTEGER CHECK (memory_entries_used IS NULL OR memory_entries_used >= 0),

  CHECK (
    (sender = 'user' AND content IS NOT NULL AND mentions IS NOT NULL AND state IS NOT NULL
      AND agent IS NULL AND text IS NULL AND in_reply_to IS NULL AND slot_id IS NULL
      AND run_id IS NULL AND memory_entries_used IS NULL) OR
    (sender = 'agent' AND content IS NULL AND mentions IS NULL AND state IS NULL AND retracted_at IS NULL
      AND request_hash IS NULL AND quote_message_id IS NULL AND replaces_message_id IS NULL
      AND agent IS NOT NULL AND text IS NOT NULL AND in_reply_to IS NOT NULL
      AND slot_id IS NOT NULL AND run_id IS NOT NULL)
  ),
  CHECK ((state = 'retracted') = (retracted_at IS NOT NULL)),
  CHECK (quote_message_id IS NULL OR quote_message_id <> id),
  CHECK (replaces_message_id IS NULL OR replaces_message_id <> id)
) STRICT;

CREATE INDEX idx_chat_messages_conversation ON chat_messages(conversation_id, created_at DESC, id DESC);
CREATE INDEX idx_chat_messages_reply_to ON chat_messages(in_reply_to) WHERE in_reply_to IS NOT NULL;

-- 消息不可变：只有「你发的消息」的 state / retracted_at 能改（撤回），其余一律拒绝
CREATE TRIGGER chat_messages_immutable BEFORE UPDATE ON chat_messages
WHEN NOT (
  OLD.sender = 'user' AND NEW.sender = 'user'
  AND NEW.id IS OLD.id AND NEW.conversation_id IS OLD.conversation_id
  AND NEW.created_at IS OLD.created_at AND NEW.content IS OLD.content
  AND NEW.mentions IS OLD.mentions AND NEW.quote_message_id IS OLD.quote_message_id
  AND NEW.replaces_message_id IS OLD.replaces_message_id AND NEW.request_hash IS OLD.request_hash
  AND NEW.agent IS OLD.agent AND NEW.text IS OLD.text AND NEW.in_reply_to IS OLD.in_reply_to
  AND NEW.slot_id IS OLD.slot_id AND NEW.run_id IS OLD.run_id
  AND NEW.memory_entries_used IS OLD.memory_entries_used
)
BEGIN
  SELECT RAISE(ABORT, 'chat messages are immutable except retraction');
END;

CREATE TRIGGER chat_messages_no_delete BEFORE DELETE ON chat_messages
BEGIN
  SELECT RAISE(ABORT, 'chat messages are immutable');
END;

-- ================================================================ 回答位
CREATE TABLE chat_reply_slots (
  id                 TEXT NOT NULL PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  user_message_id    TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE RESTRICT,
  agent              TEXT NOT NULL CHECK (length(agent) BETWEEN 1 AND 64 AND agent NOT GLOB '*[^a-z0-9-]*'),
  required           INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  outcome            TEXT NOT NULL CHECK (outcome IN (
                       'running', 'answered', 'skipped', 'absent_quota',
                       'unavailable', 'failed', 'cancelled', 'retracted')),
  -- 当前这次尝试的 Run（D-31b 建 chat_runs 之后才有值；absent_quota / unavailable 在发送时就没有）
  run_id             TEXT,
  attempt            INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  reply_message_id   TEXT REFERENCES chat_messages(id) ON DELETE RESTRICT,
  failure            TEXT CHECK (failure IS NULL OR json_valid(failure)),
  unavailable_reason TEXT CHECK (unavailable_reason IS NULL OR unavailable_reason IN ('offline', 'unconfigured', 'paused_by_user')),
  created_at         TEXT NOT NULL,
  finished_at        TEXT,
  -- 唯一键：(userMessageId, agent)。一条消息对同一个人只有一个回答位，重试只换 attempt
  UNIQUE (user_message_id, agent)
) STRICT;

CREATE INDEX idx_chat_slots_conversation ON chat_reply_slots(conversation_id);
CREATE INDEX idx_chat_slots_running ON chat_reply_slots(conversation_id) WHERE outcome = 'running';

-- 回答位的身份字段不可改（否则可以把失败的回答位改挂到别人的消息上）
CREATE TRIGGER chat_slots_identity_immutable
BEFORE UPDATE OF id, conversation_id, user_message_id, agent, created_at ON chat_reply_slots
WHEN NEW.id IS NOT OLD.id
  OR NEW.conversation_id IS NOT OLD.conversation_id
  OR NEW.user_message_id IS NOT OLD.user_message_id
  OR NEW.agent IS NOT OLD.agent
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'chat reply slot identity is immutable');
END;

-- 回答位不删（撤回 / 归档靠状态）
CREATE TRIGGER chat_slots_no_delete BEFORE DELETE ON chat_reply_slots
BEGIN
  SELECT RAISE(ABORT, 'chat reply slots are never deleted');
END;

-- ================================================================ 会话不删
CREATE TRIGGER conversations_no_delete BEFORE DELETE ON conversations
BEGIN
  SELECT RAISE(ABORT, 'conversations are never deleted');
END;

CREATE TRIGGER conversations_identity_immutable
BEFORE UPDATE OF id, kind, direct_agent, created_at ON conversations
WHEN NEW.id IS NOT OLD.id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.direct_agent IS NOT OLD.direct_agent
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'conversation identity is immutable');
END;

-- ================================================================ 新列（都可空，旧行 NULL）
ALTER TABLE projects
  ADD COLUMN from_conversation_id TEXT REFERENCES conversations(id) ON DELETE RESTRICT;

ALTER TABLE agents
  ADD COLUMN chat_persona TEXT CHECK (chat_persona IS NULL OR length(chat_persona) <= 50000);

ALTER TABLE agents
  ADD COLUMN chat_profile_id TEXT;

ALTER TABLE agents
  ADD COLUMN memory_source TEXT CHECK (memory_source IS NULL OR json_valid(memory_source));
`;

/** 迁移前备份的文件名：room.db → room.db.bak-v4 */
export const BACKUP_SUFFIX = ".bak-v";
