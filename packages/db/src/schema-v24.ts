/** 自动媒体计划与回答同事务提交；任务入队后消费，重启按来源去重恢复。 */
export const SCHEMA_V24 = `
CREATE TABLE chat_immersive_pending (
  message_id TEXT NOT NULL PRIMARY KEY REFERENCES chat_messages(id) ON DELETE RESTRICT,
  draw INTEGER NOT NULL CHECK (draw IN (0, 1)),
  speak INTEGER NOT NULL CHECK (speak IN (0, 1)),
  CHECK (draw = 1 OR speak = 1)
) STRICT;
`;
