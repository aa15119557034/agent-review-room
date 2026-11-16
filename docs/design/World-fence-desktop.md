# X-49：桌面世界 Run 的持久屏障与启动接线

2026-11-16，林离。按已合并 #244 / #247 契约实施；使用 #249 客户端，节点能力由 #248 / #250 提供。江浩已授权在 C酱额度不足期间继续推进实现。本片不新增协议字段，不启用或改写用户节点配置。

## 结果

世界调用在发送前将预算预占和原始身份写入同一个 SQLite 事务：世界/代次、节点 ID、精确 base URL、隔离 profile、来源 chat profile、recipe、账本和明确 model/effort。侧账本位于默认资料目录的 `world-usage.sqlite`，不随 `room.db` 恢复或资料切换回退；不保存 Token、Prompt 或个人记忆。

只有原账本对目标 Run 返回 `fenced_never_started` / `closed_process`，并成功持久化确认，才允许新的模型调用。取消接口成功、HTTP 流结束、`completed`、旧 Run 列表和 lease 超时均不替代停止证明。原角色/profile 删除后仍按已保存的原节点身份对账；节点 URL 改变、凭据丢失、账本不匹配或未知 recipe 均保留屏障。v1 旧账本中的预占没有完整身份，升级时保留为未知未确认记录，不猜测补全。

屏障针对模型入口：世界、普通聊天/摘要及讨论/评审共用对账；未确认状态下规则世界仍可推进、暂停、保存、退出与重新打开。完整回包也须先取得停止证明再裁决。预算不退还。关闭程序先等待已在运行的对账写入和世界写队列收束，再关闭侧账本。侧账本无法打开时模型入口关闭，规则世界仍可用。

解析模型目标时沿用角色原本聊天模型和 effort，只验证目标隔离 profile 是否支持，不替换为别的模型。每次异步初始化后检查原本角色、节点、凭据及模型配置是否仍相同；正式 HTTP 派发还由 #249 再检查节点账本和 recipe。

独立审查发现两处等待间隙，已在实现层修正：客户端最终健康检查或重试等待后，在每次实际 POST 之前同步复核原本本地配置；退出记录并等待完整的前台 handoff，包括其等待世界 drain 后才开始的对账，不只快照退出瞬间的 proof Promise。未发出的预占也仍需原账本未知 Run fence，不退还预算。

## 实际验证

在 `9df005209865c12430854f744013c39eddfce87f` 加本次工作树修改上执行：

```text
node scripts/verify.mjs all
tests 1683 / pass 1683 / fail 0 / cancelled 0
types: 9 groups, all exit 0
build-desktop: exit 0
build-agent-server: exit 0
```

原始汇总与分项日志保存在本机 `.verification/summary-all.json` 和同目录日志。覆盖：SQLite 重启/双连接、预占绑定原子性、写失败不放行、未知旧记录、错误账本/Run/recipe、取消未确认、已完成但无证明、前台抢占、迟到创建、规则推进/维护/重启保留未确认记录，以及来源模型配置变化。

独立审查修复后实际运行 `world-dispatch-config.test.ts`、`world-run-fence.test.ts`、`world-cognition.test.ts`、`world-cognition-integration.test.ts`、`world-node.test.ts` 和 `world-run-bindings.test.ts`，117/117 通过；desktop 和 desktop/e2e 类型检查均 exit 0。新增真实 HTTP 扣住最终 health 后暂停居民、修改模型、profile、URL 四条回归，均未发送旧 POST。退出竞态复审和完整主入口 smoke 另记，不以这些服务测试替代。

## 复审、集成验证与剩余范围

- 独立复审固定代码 `c7f7ab32bc1930cd5952b252f82bb6718f4da049` 未发现剩余必须修项：原样重跑最终 health 反例 1/1；按新退出顺序复跑真实 SQLite/WorldService 反例 1/1（第二次 proof 等待期间数据库保持打开，`writesAfterClose=0`、`handoffsRemaining=0`）；客户端与 resolver 相关 73/73。
- 在包含本片与 #248/#249/#250 的隔离集成 `9b8662390a2f760087641abb827337e5e8d3fc87` 上，实际编译 Electron 主入口、真实节点进程和受控 HTTP provider 完成两组 smoke。正向：世界台词落库、预算扣 1、聊天与讨论均 COMPLETED，3 次受控 provider 请求；反向：预置原账本中没有停止证明的旧 Run，世界/聊天/讨论均无 provider 请求，规则时间继续，暂停退出与再次启动后旧记录仍在、聊天/讨论继续被挡，两个进程均正常退出。测试通过主入口实际注册的 IPC handler 驱动服务，未替换主控组装；不是 GUI 验收。
- 未调用真实模型，未修改真实节点配置，未证明实际模型输出质量。
- 本片与最终 3D 分支尚未形成完整可玩交付。各分支测试通过不等于用户验收。
