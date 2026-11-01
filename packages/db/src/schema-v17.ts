/**
 * 迁移 v17（C-42c / D-37b）：「用语音回」这个开关要存下来。
 *
 * 契约里 `UserChatMessage.replyAsVoice`（你这条消息开了「用语音回」）从 C-42c 就有，
 * 但 v5 建表时没有对应的列——发出去之后重启就丢了，D-37b 的自动语音合成也就没法按它判断。
 * 只有用户消息会有这个字段（0 = 没开，NULL = 秘书的消息），所以可空。
 */
export const SCHEMA_V17 = `
ALTER TABLE chat_messages ADD COLUMN reply_as_voice INTEGER CHECK (
  reply_as_voice IS NULL OR reply_as_voice IN (0, 1)
);
`;
