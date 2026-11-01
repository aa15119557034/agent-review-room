/**
 * 迁移 v9（C-32 / C-42a / D-36b 第一段）：图片引用表。
 *
 * 图片的字节存在 userData/images/<sha256> 下一个文件（按内容去重，多张图共用一份字节）；
 * 这张表只记「一条引用记录」：
 * - ref：img_<ULID>，renderer 只拿它，`room-image://<ref>` 由 main 映射到文件
 * - purpose：这条引用是给谁用的（头像 / 背景 / 聊天 / 议题材料 / 画出来的图 / 表情）。
 *   用途校验和清理都靠它；同一种用途 + 同一个 sha256 直接复用同一条记录
 * - sha256 / mime / bytes / width / height：处理后（D-36a 管道）的样子，显示和清单都用这几个数
 *
 * bytes 的上限写的是所有用途里最大的那个（generated 10 MB）；按用途的细上限（头像 2 MB、
 * 表情 1 MB…）在 main 里用 IMAGE_MAX_BYTES 判，迁移是历史事实，不跟着契约漂。
 *
 * 聊天文件（FileRef）和表情库的表在 D-34a 自己的迁移里加，不在这里。
 */
export const SCHEMA_V9 = `
CREATE TABLE images (
  ref        TEXT NOT NULL PRIMARY KEY,
  purpose    TEXT NOT NULL CHECK (purpose IN ('avatar', 'background', 'chat', 'material', 'generated', 'sticker')),
  sha256     TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  mime       TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes      INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 10485760),
  width      INTEGER NOT NULL CHECK (width > 0),
  height     INTEGER NOT NULL CHECK (height > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_images_sha256 ON images(sha256);
CREATE UNIQUE INDEX ux_images_purpose_sha256 ON images(purpose, sha256);
CREATE INDEX idx_images_purpose_created ON images(purpose, created_at);

-- 引用记录本身不能改（换图就是新的 ref）；删是清理时的事
CREATE TRIGGER images_no_update BEFORE UPDATE ON images
BEGIN
  SELECT RAISE(ABORT, 'image refs are immutable');
END;
`;
