/**
 * 迁移 v18（C-37a / D-44）：秘书控制台按 agent 查活动。
 *
 * `agents.activity` 要按一位秘书把讨论 Turn 和聊天回答位放在一起按 (createdAt, id) 排，
 * 两张表原来都没有 (agent, created_at) 的索引（讨论只按 round / batch 查、聊天只按 conversation 查），
 * 分页会全表扫。这里各补一条。
 */
export const SCHEMA_V18 = `
CREATE INDEX idx_turns_agent_created ON turns(agent, created_at);
CREATE INDEX idx_chat_slots_agent_created ON chat_reply_slots(agent, created_at);
`;
