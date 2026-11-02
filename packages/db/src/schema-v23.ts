/**
 * 迁移 v23（C-42d / ADR-004 §3a，D-39）：沉浸模式。
 *
 * - chat_messages.immersive_deferred：写回答那一刻定下的退回原因（NULL / 省略 = 没有退回）。
 * - chat_immersive_settings：每个会话一份设置；没设置过 = DEFAULT_IMMERSIVE_SETTINGS。
 *
 * 用量不单独存表：直接数 media_jobs 里最近 60 分钟、authorization = immersive 的任务
 * （queued / running 也算；开始前被取消的不算），重启不清零，和契约的计数规则一致。
 */
export const SCHEMA_V23 = `
ALTER TABLE chat_messages ADD COLUMN immersive_deferred TEXT;

CREATE TABLE chat_immersive_settings (
  conversation_id            TEXT NOT NULL PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  enabled                    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  auto_draw_uses_subscription INTEGER NOT NULL CHECK (auto_draw_uses_subscription IN (0, 1)),
  draws_per_hour             INTEGER NOT NULL CHECK (draws_per_hour BETWEEN 0 AND 6),
  voice_clips_per_hour       INTEGER NOT NULL CHECK (voice_clips_per_hour BETWEEN 0 AND 30),
  updated_at                 TEXT NOT NULL
) STRICT;
`;
