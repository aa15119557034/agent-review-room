/**
 * 迁移 v16（C-42c / D-37b）：语音片段与音频引用。
 *
 * `audio_refs`：音频字节的引用表（和 images 同构：`aud_…` → 磁盘文件按 sha256 命名）。
 * D-34b 的录音和 D-37b 合成出来的语音共用这张表（契约里 AudioRef / AUDIO_URL_SCHEME 就是共用的）。
 *
 * `speech_clips`：合成结果的缓存索引。缓存键 = sha256(朗读文本) + voiceId + speed + engine + engineVersion
 * （契约 speech.ts 的原话），命中就不再合成；语速在合成时生效，所以改语速不会命中旧片段。
 * 片段和音频都不可变：只插入、不更新。
 */
export const SCHEMA_V16 = `
CREATE TABLE audio_refs (
  ref        TEXT NOT NULL PRIMARY KEY,
  sha256     TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  mime       TEXT NOT NULL CHECK (mime IN ('audio/ogg', 'audio/wav', 'audio/mpeg')),
  bytes      INTEGER NOT NULL CHECK (bytes > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_audio_refs_sha256 ON audio_refs(sha256);
CREATE INDEX idx_audio_refs_created ON audio_refs(created_at);

-- 引用记录本身不能改（换音频就是新的 ref）；删是清理时的事
CREATE TRIGGER audio_refs_no_update BEFORE UPDATE ON audio_refs
BEGIN
  SELECT RAISE(ABORT, 'audio refs are immutable');
END;

CREATE TABLE speech_clips (
  id             TEXT NOT NULL PRIMARY KEY,
  text_hash      TEXT NOT NULL CHECK (length(text_hash) = 64 AND text_hash NOT GLOB '*[^0-9a-f]*'),
  voice_id       TEXT NOT NULL,
  speed          REAL NOT NULL CHECK (speed >= 0.5 AND speed <= 2),
  engine         TEXT NOT NULL CHECK (engine IN ('cosyvoice', 'indextts2', 'gpt-sovits')),
  engine_version TEXT NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 60),
  audio_ref      TEXT NOT NULL REFERENCES audio_refs(ref),
  mime           TEXT NOT NULL CHECK (mime IN ('audio/ogg', 'audio/wav', 'audio/mpeg')),
  duration_ms    INTEGER NOT NULL CHECK (duration_ms > 0),
  created_at     TEXT NOT NULL
) STRICT;

-- 缓存键：同一段朗读文本、同一个声音、同样语速、同一个引擎和版本，只合成一次
CREATE UNIQUE INDEX ux_speech_clips_cache ON speech_clips(text_hash, voice_id, speed, engine, engine_version);
CREATE UNIQUE INDEX ux_speech_clips_audio ON speech_clips(audio_ref);
CREATE INDEX idx_speech_clips_created ON speech_clips(created_at DESC);

CREATE TRIGGER speech_clips_no_update BEFORE UPDATE ON speech_clips
BEGIN
  SELECT RAISE(ABORT, 'speech clips are immutable');
END;
`;
