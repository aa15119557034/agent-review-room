/**
 * 迁移 v8（C-42e / D-31d）：秘书回答上的媒体意图。
 *
 * chat_messages 加一列（可空，旧行 NULL，读的时候由 repository 省掉）：
 * - media_intent：extractMediaIntent 的合格结果（MediaIntent：speak / draw），和回答在**同一个事务**里写入。
 *   一项都不合格就写 NULL（界面看到的就是「这条没有媒体意图」），被丢掉的原始值只进日志审计。
 *   immersive_deferred（沉浸模式没自动执行的原因）留给 D-39 自己加列。
 *
 * 必须重建 chat_messages 的不可变触发器：v5 的触发器是逐列比对新旧值的，它不认识的列改了也不会拦。
 * 加列之后不补进比对，media_intent 就能被 UPDATE 改掉——消息不可变的保证会在这里破一个口子。
 *
 * ALTER TABLE 只加可空列，不改数据和索引；旧库升级只走这一次，可安全重跑（runMigrations 按 user_version 判断）。
 */
export const SCHEMA_V8 = `
ALTER TABLE chat_messages ADD COLUMN media_intent TEXT CHECK (
  media_intent IS NULL OR (json_valid(media_intent) AND json_type(media_intent) = 'object'));

DROP TRIGGER chat_messages_immutable;
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
  -- C-42e：媒体意图和回答一起落库之后也不能改
  AND NEW.media_intent IS OLD.media_intent
  -- 撤回只能 sent → retracted 一次：不能撤销撤回、也不能改撤回时间
  AND (
    (NEW.state IS OLD.state AND NEW.retracted_at IS OLD.retracted_at)
    OR (OLD.state = 'sent' AND NEW.state = 'retracted')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'chat messages are immutable except retraction');
END;
`;
