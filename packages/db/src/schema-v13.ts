/**
 * 迁移 v13（C-44 / D-40，ADR-003 §2a「主控机拆成两个节点」）：林离的参与者从
 * `controller-local`（汐的节点，7420）迁到 `controller-local-codex`（林离的节点，7421）。
 *
 * 为什么要有这一步：S-20 把主控机拆成两个节点之后，节点上的 profile 和 Token 都按秘书分开了；
 * 数据库里 `agents.node_id` 还指着旧的 `controller-local`，讨论和聊天会把林离的 Run 发到 7420。
 *
 * 只动「已经指向 controller-local 的 codex」这一种情况：
 * - 江浩电脑上的库（codex 在 user-pc）不受影响
 * - 节点行已经存在就保留它原来的地址，不覆盖用户自己配的
 * - 重复跑没有副作用（v13 只会执行一次，SQL 本身也是幂等的）
 *
 * Token 不在这里搬：两个节点的 Token 是两份，要各自用 `node.importLocalToken` 导入（C-44）。
 */
export const SCHEMA_V13 = `
-- 1. 林离的节点行：没有就补一条，地址固定 127.0.0.1:7421（S-20 装的 codex 节点）
INSERT INTO nodes (id, display_name, base_url, created_at)
SELECT 'controller-local-codex', '主控机（林离）', 'http://127.0.0.1:7421', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM agents WHERE id = 'codex' AND node_id = 'controller-local')
  AND NOT EXISTS (SELECT 1 FROM nodes WHERE id = 'controller-local-codex');

-- 2. 林离的参与者迁到新节点（讨论和聊天都按 agents.node_id 选节点）
UPDATE agents
SET node_id = 'controller-local-codex',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'codex' AND node_id = 'controller-local';
`;
