/**
 * 迁移 v22（C-46 / ADR-005 §5，D-46c）：项目笔记同步到 GitHub 的队列和状态。
 *
 * - github_push_queue：按路径排队（同一个路径只留最新一份内容），推上去才删。断网 / Token 失效就留着下次再试。
 * - github_sync_state：单行。private 是最近一次检查的结果（NULL = 还没查过），lastError 给界面显示。
 * Token 不在这两张表里：只在设置文件的加密字段（main 进程读）。
 */
export const SCHEMA_V22 = `
CREATE TABLE github_push_queue (
  path          TEXT NOT NULL PRIMARY KEY,
  content       TEXT NOT NULL,
  message       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error    TEXT
) STRICT;

CREATE INDEX idx_github_push_queue_created ON github_push_queue(created_at);

CREATE TABLE github_sync_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  private           INTEGER CHECK (private IN (0, 1) OR private IS NULL),
  last_pushed_at    TEXT,
  last_error        TEXT CHECK (last_error IS NULL OR last_error IN ('public_repo', 'no_token', 'unauthorized', 'not_found', 'network', 'other')),
  last_error_message TEXT,
  CHECK ((last_error IS NULL) = (last_error_message IS NULL))
) STRICT;

INSERT INTO github_sync_state (id) VALUES (1);
`;
