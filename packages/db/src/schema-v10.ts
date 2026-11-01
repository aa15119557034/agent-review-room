/**
 * 迁移 v10（C-34 / C-42a / D-34a）：聊天文件表 + 表情库表。
 *
 * - files：你发的非图片文件（FileRef）。字节存 userData/files/<sha256>，按内容去重：
 *   同一份内容（同一个 sha256）只有一行，名字取第一次选它时的那个。
 *   is_text = 能以 UTF-8 读成文字（txt / md / csv / json / 代码），只有这类文件的正文会进 Prompt。
 * - chat_stickers：表情库。一行指向一条 images 引用（用途 sticker），label 是发给秘书的说明
 *   （「[表情：小鲸鱼比心]」），最多 CHAT_LIMITS.stickersMax 条由 main 校验。
 *
 * 两张表都只增不改；删表情时只删这一行，图片引用和字节留给清理（引用的复用规则见 C-32）。
 */
export const SCHEMA_V10 = `
CREATE TABLE files (
  ref        TEXT NOT NULL PRIMARY KEY,
  sha256     TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  mime       TEXT NOT NULL CHECK (length(mime) BETWEEN 3 AND 100),
  bytes      INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 20971520),
  is_text    INTEGER NOT NULL CHECK (is_text IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_files_sha256 ON files(sha256);

CREATE TABLE chat_stickers (
  id         TEXT NOT NULL PRIMARY KEY,
  image_ref  TEXT NOT NULL REFERENCES images(ref) ON DELETE RESTRICT,
  label      TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_chat_stickers_created ON chat_stickers(created_at);

CREATE TRIGGER files_no_update BEFORE UPDATE ON files
BEGIN
  SELECT RAISE(ABORT, 'file records are immutable');
END;
`;
