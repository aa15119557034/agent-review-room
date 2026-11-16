# Run fence v1 节点实现

本片实现已合入 #244 的节点侧持久准入和停止证据。desktop 持久绑定、全局模型屏障和独立 world profile 不在本片；不能据此开启真实世界模型。合并前先本地合入 #242 的直接 child close 修复。

## 配置与初始化

旧配置不需要增加字段，也不报告 runFence 能力。要启用，节点本地显式配置可选 runFenceDir；相对路径按配置文件目录解析。操作员先准备一个只属于该节点、已有且空的状态目录，再运行与正常启动相同的程序加 --init-run-fence。初始化只创建 identity.json、records.jsonl、commits.jsonl，成功打印新 ledgerId 并退出；正常启动不会自动初始化、补文件或修复损坏。已有非空目录不能再次初始化。

例如配置字段为 "runFenceDir": "state/run-fence"，打包入口使用 node agent-server.mjs --init-run-fence。开发入口使用 node node_modules/tsx/dist/cli.mjs apps/agent-server/src/main.ts --init-run-fence。运行前仍使用已有 AGENT_SERVER_CONFIG 指向操作员选定的配置。本片没有修改真实配置、安装 ACL 或凭据。

第一版只支持 Windows 本地绝对盘符目录。配置解析后的输入不能是 UNC、namespaced 路径、段尾点/空格或链接组件；realpath 不同的路径别名拒绝。账本文件必须是普通单链接文件。未验证平台不报告能力，显式启用会启动失败。目录不得被外部重命名、替换、回滚或复制后沿用同一身份继续服务。

## owner 与持久提交

- 先取得 canonical 目录名派生的固定 Windows pipe，再取得 ledgerId 派生的固定 pipe。合作 Node/libuv owner 的第二次绑定失败；目录复制也不能同时自称同一 ledger。
- 本机实际版本为 Node 24.19.0 / libuv 1.52.1。真实子进程覆盖同目录、大小写别名、同 identity 副本竞争及 owner 被强杀后的重新取得；scratch 探针另覆盖不同 cwd / 分隔符 / .. / namespaced 输入归一化。生产选择拒绝未经支持的路径形式。
- pipe 只作 owner，不能通过 unlink 文件或超时抢占。它不是对管理员、任意原生程序、所有 Windows session 或全部路径别名的安全隔离证明。
- identity 的 hash 写入两个日志头；记录包含 ledgerId、连续 seq、前记录 hash、RunId、请求身份 hash 与转换。提交链逐条绑定记录 hash。请求身份复用原有幂等比较范围，不存正文、环境或 Token。
- 同步完整写记录并 fsync，再完整写提交链并 fsync，之后才能更新可见状态、spawn 或回复成功。写入短返回会继续写，零进度或异常使 writer 失效。日志采用已有文件 r+ 定点追加，缺失文件不会被自动重建。
- 启动逐条核对身份、链、序号、合法状态转换和两份日志长度。完整链再次 fsync 后才提供证明；半条记录、未匹配尾部或缺文件直接拒绝，不截尾修复。
- 运行中每次访问验证 owner 和三份完整文件，变化会使 writer 失效。第一版校验是 O(历史长度)，日志与永久 fence 不做 TTL 或压缩，尚未做多年历史容量/延迟测试。

这些检查不能检测 identity 和全部依据一起被外部回滚成自洽旧副本，也不承诺任意断电下目录元数据不会丢失。发现可检测的缺损会拒绝原身份继续执行/证明；不能为恢复可用性删除日志或重用旧身份。明确重建必须选择新 identity，且不能解除桌面侧旧绑定。

## 请求与生命周期

未知 cancel 先提交 fenced，再返回 202；proof 设置 no-store。要求 expectedLedgerId 的请求在旧节点或身份不符时拒绝，不降级。start 在 verifyCommit 等异步校验之后再次核对关闭状态、identity、fence、已有 Run 和容量；最终检查到 admitted 提交和 spawn 之间没有 await。

admitted 重启后仍为 unconfirmed 并占用容量。原 owner 在未调用 spawn 前明确失败，或 Node 报明确创建失败时，才记录 never_spawned；正常/非零退出只能由直接 ChildProcess close 记录 closed_process。不拿 lease、terminal、PID 缺席或计时器代替证据。证据提交失败时 terminal 仍可存在，但 health/proof/新准入保守报错，不能由 isFinished 释放屏障。

TTL 只删内存事件/输出对象，永久消耗的 RunId 不再执行。关闭先设置 closing，已在 await 的请求最终拒绝；有界等待不制造 terminal。释放 owner 前不可逆封闭旧 writer，旧 child 的迟到 close 只能记录“证据未提交”，不能在新 owner 下写入。新 owner 看到未确认记录继续保留容量。

closed_process 只证明直接受管子进程的 close，不证明 wrapper、工具或脱离管道后代全部停止。真实模型还需独立 profile 范围验收。

## 实测入口

- apps/agent-server/test/run-ledger.test.ts：真实双 owner / 复制身份冲突、admitted 后强杀重启、写/fsync 两阶段失败、短写、部分丢失和路径拒绝。
- apps/agent-server/test/run-fence-http.test.ts：真实 loopback HTTP 扣住 POST、await 内取消和并发、TTL、恢复容量、关闭、明确未启动和证据写失败。
- apps/agent-server/test/remote-run-stop.test.ts：受控 fake child 的 kill 失败/no close，以及真实 owner 锁下晚回调封闭。

所有模型进程均为临时自有 Node fixture 或受控 fake，不连接真实节点或供应商。
