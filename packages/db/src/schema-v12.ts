/**
 * 迁移 v12（C-42a / C-34，D-34b 第一段）：录音。
 *
 * 一行 = 一段录音（`aud_…`，契约 VoiceRecording）。录音本体的字节存 userData/audio/<sha256>，
 * 这里记 sha256 / 类型 / 字节数 / 时长 / 转写状态。
 *
 * 状态只有三种：transcribing（刚导入，正在本地转写）→ ready（有转写）或 failed（有原因）；
 * 和契约的 refine 一一对应：只有 ready 有 transcript、只有 failed 有 error。
 */
export const SCHEMA_V12 = `
CREATE TABLE voice_recordings (
  audio_ref  TEXT NOT NULL PRIMARY KEY,
  sha256     TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  mime       TEXT NOT NULL CHECK (mime IN ('audio/wav', 'audio/ogg', 'audio/webm')),
  bytes      INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 16777216),
  duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 1 AND 300000),
  status     TEXT NOT NULL CHECK (status IN ('transcribing', 'ready', 'failed')),
  transcript TEXT CHECK (transcript IS NULL OR json_valid(transcript)),
  error      TEXT CHECK (error IS NULL OR (length(error) BETWEEN 1 AND 2000)),
  created_at TEXT NOT NULL,
  CHECK ((status = 'ready') = (transcript IS NOT NULL)),
  CHECK ((status = 'failed') = (error IS NOT NULL))
) STRICT;

CREATE INDEX idx_voice_recordings_created ON voice_recordings(created_at DESC, audio_ref DESC);

-- 按内容去重：同一段录音（同一个 sha256）只有一条（C酱 #126）
CREATE UNIQUE INDEX ux_voice_recordings_sha256 ON voice_recordings(sha256);

-- 转写结束以后不再改：要重来就重新导入（和 media_jobs 的终态触发器一样，C酱 #126）
CREATE TRIGGER voice_recordings_terminal_final BEFORE UPDATE ON voice_recordings
WHEN OLD.status <> 'transcribing'
BEGIN
  SELECT RAISE(ABORT, 'voice recordings are final once transcribed');
END;
`;
