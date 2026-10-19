# @room/db — 负责：DeepSeek ｜ 审查：Claude

SQLite（better-sqlite3）：migration、WAL、busy_timeout、单写者队列、BEGIN IMMEDIATE、ULID（D-02）。
数据库文件放在 Electron userData，不放进仓库。

## 用法

```ts
import { openDatabase, ulid, WriteQueue, writeTransaction } from "@room/db";

const db = openDatabase(join(userDataDir, "room.db")); // 自动跑迁移、开 WAL
const queue = new WriteQueue();

await writeTransaction(db, queue, () => {
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)")
    .run(ulid(), "示例项目", new Date().toISOString());
});
```

## 表结构（v1）

| 表 | 说明 |
|---|---|
| `projects` | 项目 |
| `messages` | 原始消息，**不可变**（trigger 拦 UPDATE/DELETE） |
| `contributions` | 从某条 message 截出的片段，保存 selection 区间 |
| `prompt_snapshots` | 实际发给 Reviewer 的原文，**不可变** |
| `approvals` | 审批记录 |
| `runs` | 执行记录，`approval_id` **UNIQUE** |
| `run_events` | run 的完整事件流，**只追加**，每个 run 最多一个终止事件 |

### 几个刻意的决定

1. **CHECK 约束由契约枚举生成**（`src/schema.ts` 里读 `ApprovalState.options` 等）。
   SQL 里不重抄枚举，契约改了这里自动跟着变，避免「代码允许、数据库拒绝」。
2. **STRICT 表**：SQLite 3.37+ 的类型强校验。better-sqlite3 13 自带 3.53，没问题。
3. **时间戳存 ISO 字符串**，与 `IsoTimestamp` 契约一致；排序主要靠 ULID 主键的字典序。
4. **`contribution_ids` 存 JSON 文本**（带 `json_valid` + 非空数组校验），Phase 0 不做 join 表；
   真要按 contribution 反查 snapshot 再建关联表。
5. **不可变用 trigger 兜底**：应用层写错了也改不动历史（AC-4 / V0.3 §17）。
   代价是删除项目会被 FK 的 `ON DELETE RESTRICT` + trigger 拦住 —— Phase 0 不做删除。
6. **`substate` 只在 RUNNING 非空、`failure_reason` 只在 FAILED 非空**，把 entities.ts 的注释变成约束。
7. **`run_events` 用部分唯一索引保证每个 run 最多一个终止事件**（AC-9），且只追加、不允许改删。
8. **Run 必须对应「批准了同一份 snapshot」的 Approval**（AC-7）：`BEFORE INSERT` 触发器校验
   `approvals.id = runs.approval_id AND approvals.snapshot_id = runs.snapshot_id AND state = 'APPROVED'`。
   代码传错参数也插不进去；顺带强制「先把 Approval 改成 APPROVED，再插 Run」的顺序。
   Run 的 `approval_id` / `snapshot_id` / `project_id` 之后不可改。
9. **跨表一致性**：Contribution 必须与其来源 message 同项目；Approval 必须与其 snapshot 同项目。

### 关于 `synchronous = NORMAL`

WAL 下应用崩溃不丢已提交事务；**但断电可能丢最后几个事务**。Phase 0 接受这个取舍：
丢的只可能是最后写入的评审记录，且 `-wal` 回放仍会执行。要更强保证可改 `FULL`，代价是每次提交多一次 fsync。

## 单写者队列

`WriteQueue` 把写操作串成一条链，`writeTransaction` 用 `BEGIN IMMEDIATE`。

- 为什么需要：better-sqlite3 是同步 API，同进程内两个写事务交错会直接抛
  `cannot start a transaction within a transaction`。
- 为什么用 IMMEDIATE：一开始就拿写锁，避免「先读后写」时锁升级失败且无法重试。
- **`work()` 里不要放 await**：写锁会跨越事件循环，其他写者全程阻塞。
- 跨进程互斥交给 SQLite（`busy_timeout = 5000`）。

## ULID

26 字符 Crockford Base32：48 位毫秒 + 80 位随机。同一毫秒内递增，时钟回拨时沿用上次时间戳，
保证「按 ID 排序 = 按创建时间排序」，且不会因回拨产生更小的 ID。

## 测试

```bash
pnpm --filter @room/db test
```

覆盖：迁移幂等、WAL/FK/busy_timeout、FK 与 CHECK 拒绝非法数据、approval_id 唯一、
不可变 trigger、ULID 单调性、并发写串行化与回滚、AC-10（关库重开后仍可读）。