/**
 * 迁移 v19（D-34b 第二段 / #137 评审第 1 条）：录音和合成语音共用 `audio_refs`，收 `audio/webm`。
 *
 * 浏览器录音（`MediaRecorder`，Chromium）默认就是 `audio/webm;codecs=opus`；v16 建表时只列了
 * ogg / wav / mpeg，录音进不了这张表，才会出现「两套存储」的问题。这里把 CHECK 放宽到四种。
 *
 * SQLite 改不了 CHECK，只能重建表：拷数据 → 删旧表 → 改名 → 重建索引和触发器（内容和 v16 一致）。
 */
export const SCHEMA_V19 = `
CREATE TABLE audio_refs_v19 (
  ref        TEXT NOT NULL PRIMARY KEY,
  sha256     TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  mime       TEXT NOT NULL CHECK (mime IN ('audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/webm')),
  bytes      INTEGER NOT NULL CHECK (bytes > 0),
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO audio_refs_v19 (ref, sha256, mime, bytes, created_at)
SELECT ref, sha256, mime, bytes, created_at FROM audio_refs;

DROP TABLE audio_refs;
ALTER TABLE audio_refs_v19 RENAME TO audio_refs;

CREATE UNIQUE INDEX ux_audio_refs_sha256 ON audio_refs(sha256);
CREATE INDEX idx_audio_refs_created ON audio_refs(created_at);

CREATE TRIGGER audio_refs_no_update BEFORE UPDATE ON audio_refs
BEGIN
  SELECT RAISE(ABORT, 'audio refs are immutable');
END;
`;
