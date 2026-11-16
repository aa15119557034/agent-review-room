# Run fence v1：持久准入记录与停止证据

状态：契约已通过 #244 合并。节点运行时见 [Run-fence-runtime.md](./Run-fence-runtime.md)；desktop 绑定与独立 world profile 仍待后续实现，不启用真实世界模型。

本契约补充现有 AgentServer v1，处理两类已复现问题：创建 POST 迟到时，未知 ID 的取消不能阻止执行；取消已有进程时，计时器曾在没有 `close` 的情况下生成 `finished`。后者的独立修复仍不能替代持久化与重启对账。

## 1. HTTP 增量与兼容

- `NodeHealth.capabilities.runFence?: { version: 1, ledgerId: RemoteRunLedgerId }`。ledgerId 格式为 `rled_<ULID>`。未上报就是不支持，不补默认值。
- `StartRunRequest` 与 `CancelRunRequest` 各增加可选 `expectedLedgerId`。它与当前账本不同则返回 **409 / run_ledger_mismatch**，不能对新账本执行替代操作。
- 新增 **GET /v1/runs/:runId/proof**，返回 `RemoteRunProof`。需要现有 Bearer 认证；合法 RunId 返回 200，设置 `Cache-Control: no-store`。畸形 ID 是 400，读取失败或账本损坏是服务错误，不能伪装为 missing。
- **409 / run_fenced** 表示该 ID 已永久消耗，不能创建替代执行。

`REMOTE_PROTOCOL_VERSION` 仍为 1；`RemoteRunSummary`、现有 runs 列表、`StartRunResponse` 和 cancel 的 `{ok:true}` 响应不变。普通旧请求可继续省略新字段。要求持久 fence 的调用方须先协商能力，并在创建和取消请求中都带 `expectedLedgerId`；旧节点不支持时不能去掉字段重发世界请求。

```json
{"capabilities":{"runFence":{"version":1,"ledgerId":"rled_00000000000000000000000001"}}}
```

以上是 health 的局部示例。完整 StartRun 请求只需新增 `expectedLedgerId`，不带节点命令或路径。未知取消及查询例如：

```text
POST /v1/runs/run_00000000000000000000000002/cancel
{"reason":"world yielded to foreground","expectedLedgerId":"rled_00000000000000000000000001"}

GET /v1/runs/run_00000000000000000000000002/proof
{"runId":"run_00000000000000000000000002","ledgerId":"rled_00000000000000000000000001","status":"fenced_never_started"}
```

proof 不返回 profile、PID、命令、Token、prompt 或输出正文。调用方必须核对返回的 runId 和派发前绑定的 ledgerId。

## 2. 四态的保证范围

| status | 肯定知道的事实 | 不能据此推断什么 |
|---|---|---|
| missing | 已验证完整的这份账本没有该 ID | POST 仍可能在途中；不是停止证明，应先取消再查询 |
| unconfirmed | 已有持久 admitted 记录，但没有可返回的肯定证据；包括运行、取消未确认、崩溃或证据写失败 | 不能由内存 Map/PID 缺席、时间经过、租约或 terminal 推定停止 |
| fenced_never_started | 已持久禁止同 ID 执行，并有肯定证据证明目标执行从未启动 | 证据必须是取消先于准入，或原 owner 确知未调用 spawn / 明确 spawn 失败；不能以未知错误、非零退出码或重启后 PID 缺席代替 |
| closed_process | 已持久禁止同 ID 重建，并持久记录直接受管 ChildProcess 的 `close` | **不保证后代、脱离管道的任务或外部副作用已停，不自动等于可放行前台** |

非零 exit code 意味着执行可能已经发生，不能归为 never_started。原 owner 确知命令解析失败且未调用 spawn，或得到明确的进程创建失败，才可以追加未启动证据；泛化 catch、网络失败和“不知道子进程在哪里”均不满足条件。

已有的 `terminal` 和列表 `finished` 不升级成全进程树证明。使用 closed_process 放行世界前台，还须与另外审定并验证的 world profile 执行范围相匹配；wrapper、工具、hook、MCP 或后台子任务的隔离没有确认前，真实模型入口保持关闭。

## 3. 单一 owner、排序与持久性

1. **同一 ledger 必须只有一个合法执行 owner。** 节点获得并持续保持可靠互斥后，才可修改账本或准入进程；多个节点进程误用同一状态目录时，后启动者必须拒绝取得执行权，不能两次 spawn 同一个 ID。仅检查 PID 文件或“锁超过一段时间”不足以认定旧 owner 已死。互斥细节由实现选择，不允许靠配置名称自报保证。
2. **所有会改变状态的请求先核对 expectedLedgerId。** health 与 POST 之间换了账本，创建和取消都必须拒绝，不能重新绑定到新 identity 后继续。
3. **未知取消先持久化，后响应成功。** 对未知 ID 写入禁止创建记录并完成持久提交之后才响应 202。202 只说明取消已接收；停止证据通过 proof 查询。同 ID 的迟到 POST 永远不能启动。
4. **创建/取消按同一 RunId 原子排序。** 所有 await 校验完成后（现有 verifyCommit 包含 await），最终准入处再次检查 ledger、fence、已有 Run 和容量。持久 admitted 成功之后才可 spawn；检查到持久准入之间不能让取消插入空隙。
5. **admitted 表示可能已启动。** 准入落盘后、spawn 前崩溃，重启仍为 unconfirmed。节点不能因当前无 ChildProcess 对象或查不到裸 PID 改成 never_started。原 owner 尚活着且有肯定未启动依据时，可以追加证据，但不得覆盖 admitted 历史来假装没准入过。
6. **一个 ID 永久只准入一次。** 活着的同请求重试仍可按现有规则返回 already_exists；只有持久记录、没有可复用内存 Run 的请求不得启动替代进程，返回 run_fenced。原请求身份不一致仍可返回 run_id_conflict。任何分支都不能再次 spawn 同 ID。
7. **TTL 只清理事件和输出。** 准入/fence 记录与肯定证据不得跟着过期。同一存储域重启后保留 ledgerId 与已消耗 ID；只有肯定证据持久提交后，proof 才返回对应肯定状态。
8. **不能把可检测的残缺账本当空白账本。** 完整性保证覆盖实现控制的写入、重启、TTL/清理，以及依靠持久完整性依据可检测的 identity/记录损坏或部分丢失。发现这些异常时必须拒绝原 ledger 的执行/证明，不能直接新建旧 ID；仅用 `existsSync(runFile)` 判 missing 不合格。
9. **重建必须是明确的新 identity。** 异常启动可以失败；若明确重建为新 ledger，必须换身份，且不能在旧 owner 仍存活时重新声称原 identity。新账本的 missing/fence 永远不能证明旧账本的 Run 已停止。**外部把 identity 和全部记录整体回滚成自洽旧副本，无法只靠同目录的数据自证发生过回滚；本契约不支持这种操作，也不承诺自动检测。** 若要使用这类副本，必须显式建立新 ledger，旧绑定仍不解除，不能复用旧身份继续证明旧 Run。

取消已启动进程仍须等待肯定证据；有界等待失败可以报告未确认，不能释放其运行容量或制造终态来绕过屏障。正常服务关闭可以有期限，但期限到达不生成停止证明。

## 4. 后续实现的最小范围

节点可以使用 `node:fs`，不要求引入 SQLite/native 依赖。一个实现方向是持久 identity、独占 owner 与按 RunId 的只增记录：首条为 fenced/admitted，肯定 closed/never_spawned 证据只追加，不覆写已准入历史；记录须持久提交后才准入或回应成功。

按 ID 分文件的实现还须配合完整性依据，识别其覆盖范围内的 Run 文件或目录部分丢失；不能将文件不存在直接等同于从未见过该 ID。初始记录、索引和证据半写时保守失败或 unconfirmed，不删除损坏记录来恢复派发。该依据也属于账本，不能识别它与全部记录一同被外部替换为自洽旧副本的情况；这种整体回滚按第 3 节第 9 条处理。具体文件格式不在此冻结，实现 PR 必须证明 owner 互斥、持久提交、故障恢复及实际可检测的完整性边界。文件路径拼接前先校验 RunId；不存 Token、prompt、环境变量或个人记忆。

重启后尚无肯定证据的 admitted 可继续保持 unconfirmed，第一版不要求自动接管陌生进程，也不能仅凭可复用的 PID 杀进程。旧 owner 与存活后代的范围须按实际执行方式验证。

## 5. 桌面派发前持久绑定

后续桌面实现应在默认实例的独立 `world-usage.sqlite` 中，与额度 reservation 同事务保存以下关联：runId、agent、worldId、generation、sceneId、nodeId、精确 baseUrl、profileId、ledgerId、reservedAt，以及后续取得的证据种类和确认时间。已在 reservation 中存在的字段可关联复用，不另存 Token 或模型正文。

绑定 durable commit 之前不发创建 POST。提交后即使还没真正发送就崩溃，也对原 ledger/RunId 取消并查证，不猜它未发送，不重放旧模型请求，不退额度。重启时，所有未解决绑定先构成全局模型准入屏障，覆盖所有绑定节点；规则世界和只读 UI 可以继续。

普通 chat/discussion 与新世界模型都要经过同一屏障。按原 nodeId + baseUrl 取 main 凭据并核对 ledger；不改用居民现在的新节点，不按 profile 批量取消无关 Run。网络不可达、凭据缺失、identity 改变、证据不够或本地确认写失败，都保留屏障。reset、恢复旧 room.db、切换 active-data 或删除居民不能删除这些记录。closed_process 是否足以放行仍由执行 profile 边界决定。

## 6. 验收要求

schema 测试只证明格式和旧请求兼容；下列持久性/生命周期场景须由后续实现以真实 HTTP、临时存储和可控进程验证，不能把本次 schema 测试当成已通过：

| 场景 | 必须得到的结果 |
|---|---|
| 扣住创建 POST，未知取消先成功，再放行 POST | fenced_never_started，迟到创建拒绝，目标 CLI 启动 0 次 |
| 创建停在 await 校验，期间取消 | 最终准入重新检查 fence，目标 CLI 启动 0 次 |
| 同目录两个节点进程争同一 Run | 只有一个合法 owner，至多一次 spawn；不能按超时抢走活 owner |
| kill 失败且没有 close，超过计时期限 | unconfirmed，不释放容量，不伪造 terminal |
| 原 owner 确知未调用 spawn / 明确创建失败 | 持久未启动证据后可报 fenced_never_started；非零进程退出不能走这条 |
| admitted 后、spawn 前节点崩溃 | 重启为 unconfirmed；同 ID 不启动替代执行 |
| fence 成功后重启，再放行旧 POST | ledger 不变，仍然拒绝创建 |
| 事件过 TTL 后重发同 ID | 不再启动，proof 仍可查 |
| health 后 identity 改变 | expectedLedgerId 拒绝创建和取消；不操作替代账本 |
| 实现控制的写入/清理异常，或完整性依据能检测的 identity/索引/Run 文件损坏、部分丢失 | 不重用旧身份声称完整，不按 missing 创建旧 ID，不误发肯定证明 |
| identity 和所有记录被外部整体回滚为自洽旧副本 | 不声称同目录能自动检测；不支持沿用旧身份，使用副本须显式新 ledger，旧绑定仍不解除 |
| 桌面绑定落盘前后任意点崩溃 | 未绑定不发请求；已绑定恢复时按原节点取消/查证，旧回应不重放 |
| 两个旧节点一个停止、另一个不可达 | 全局模型准入仍阻挡 |
| 根进程 close 但脱离管道的后代仍活 | 只报告准确的 closed_process，不能宣称全树已停 |

节点存储、remote-client 的公开 cancel/proof 方法、桌面跨重启对账和独立 world profile 均留在后续实现 PR。本契约不声称这些实现或真实模型验收已经完成。
