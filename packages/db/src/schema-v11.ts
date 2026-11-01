/**
 * 迁移 v11（C-42b / D-38a）：媒体任务（画图 / 语音合成）。
 *
 * 一行一个 MediaJob：kind、状态、授权来源、来源（聊天消息或议题消息）、意图 hash、画图请求 / 选路记录 /
 * 节点上的 Run / 生成结果 / 语音片段、失败原因、取消原因、时间。
 *
 * 和 Run 的规矩一样：**恰好一个终态**，状态只按 MEDIA_JOB_TRANSITIONS 往前走（代码里 assertTransition 兜着）；
 * 终态之后不再改任何字段（触发器拦）。
 *
 * 画图任务必须有 draw（请求）；语音任务没有。succeeded 的画图任务必须有 result、语音任务必须有 speech；
 * failed 必须带 failure、cancelled 必须带 cancelReason（和契约里 MediaJob 的 refine 一一对应，迁移是历史事实）。
 */
export const SCHEMA_V11 = `
CREATE TABLE media_jobs (
  id             TEXT NOT NULL PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('draw', 'speech')),
  state          TEXT NOT NULL CHECK (state IN (
                   'queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  authorization  TEXT NOT NULL CHECK (authorization IN ('user_tap', 'user_play', 'reply_as_voice', 'immersive')),
  source         TEXT NOT NULL CHECK (json_valid(source)),
  intent_hash    TEXT CHECK (
                   intent_hash IS NULL OR
                   (length(intent_hash) = 64 AND intent_hash NOT GLOB '*[^0-9a-f]*')),
  draw           TEXT CHECK (draw IS NULL OR json_valid(draw)),
  route          TEXT CHECK (route IS NULL OR json_valid(route)),
  remote_run_id  TEXT,
  result         TEXT CHECK (result IS NULL OR json_valid(result)),
  speech         TEXT CHECK (speech IS NULL OR json_valid(speech)),
  failure        TEXT CHECK (failure IS NULL OR json_valid(failure)),
  cancel_reason  TEXT CHECK (cancel_reason IS NULL OR cancel_reason IN (
                   'user_cancel', 'user_stop', 'immersive_off', 'message_withdrawn', 'superseded', 'app_restart')),
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT,

  CHECK ((kind = 'draw') = (draw IS NOT NULL)),
  CHECK ((state = 'failed') = (failure IS NOT NULL)),
  CHECK ((state = 'cancelled') = (cancel_reason IS NOT NULL)),
  CHECK (kind <> 'draw' OR (state = 'succeeded') = (result IS NOT NULL)),
  CHECK (kind <> 'speech' OR (state = 'succeeded') = (speech IS NOT NULL)),
  -- 终态一定有结束时间；还没结束的没有
  CHECK (
    (state IN ('succeeded', 'failed', 'cancelled', 'timed_out')) = (finished_at IS NOT NULL)
  ),
  -- queued 还没开始
  CHECK (state <> 'queued' OR started_at IS NULL)
) STRICT;

CREATE INDEX idx_media_jobs_created ON media_jobs(created_at DESC, id DESC);
CREATE INDEX idx_media_jobs_active ON media_jobs(created_at) WHERE state IN ('queued', 'running');

-- 终态之后不能再改（"停" / 取消只能发生在结束之前）
CREATE TRIGGER media_jobs_terminal_is_final BEFORE UPDATE ON media_jobs
WHEN OLD.state IN ('succeeded', 'failed', 'cancelled', 'timed_out')
BEGIN
  SELECT RAISE(ABORT, 'media jobs are final once they reach a terminal state');
END;
`;
