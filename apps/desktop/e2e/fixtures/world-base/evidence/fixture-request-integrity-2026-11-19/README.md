# 本机素材请求完整性验收

这次复核用 Electron 44.9.0、Chromium 152.0.7977.167，从已准备的场景 `58a46094de1ac23493f35f1bea94683df5d49c2d` 加载真实素材。完整场景进入就绪状态，场景错误和 JS 异常均为 0。两种实验都关闭硬件加速。正常场景驱动替换 WebGL 渲染器，并在场景建成后结束，因此本组数据只评价网络收件。

| 原生实验 | 本机 HTTP 与 CDP 回执 | 内容核对 |
|---|---:|---|
| 完整场景 | 272 / 272 | 272 个 GET 200 的源与响应正文长度、SHA-256 均相同，另有 83 条来自应用读取 API 的回执。15 个浏览器 `blob:` 请求单独列出。 |
| 人工对照 | 214 / 214 | 211 个指定素材请求和 3 个页面引导请求。200 个正常样本全部通过。8 个有意故障及同 URL 双请求中的坏体均被拒。 |

服务器给每次响应签发独立回执。CDP 将响应头中的回执绑定到自己的 `requestId`，验收再逐条比对 HTTP 方法、状态、含查询串的路径和终态。所有本机 GET 200 都从实际 `Content-Length` 和写入响应的字节复核源内容。Fetch 素材及原始取消请求还需应用自己的读取证明。显式取消、读取错误、缺失或重复回执、同长错体均使完整性检查失败。

双请求对照对相同的周转筐 URI 同时读取两次。两次都是 HTTP 200 且 CDP 完成，两次应用也都收到 186,848 字节。第二个响应只翻转首字节，各自的请求 ID 与回执将它准确识别为坏体。另有两次并发的 Three 加载被合并成一个 HTTP 请求，两个调用方均正常返回。归档保留 ID 与回执的一一对应关系，替换了本机端口和进程相关标识。[211 项对照与源、响应、应用哈希](controls.json.gz)

完整场景的原始 CDP 零失败检查仍未通过。5 个取消对应立石、岩石组、成熟樱树、周转筐 glTF 和周转筐 BIN。这 5 个同 ID 的响应与应用实收长度、哈希逐一匹配。[完整场景逐请求记录](normal-scene.json.gz)

### 复跑

在验收分支的 fixture 根目录使用 Node 和已有 Electron。`WORLD_FIXTURE` 指向已完成资源准备的场景 fixture，`ELECTRON` 指向本机可执行文件，`RUN` 使用一个新的绝对输出目录。以下为 Windows cmd 命令。

```bat
set "RUN=%CD%\artifacts\request-integrity-replay"
node --test scripts/acceptance-transport.test.cjs
node scripts/check-fixture-transport.cjs "--electron=%ELECTRON%" "--fixture=%WORLD_FIXTURE%" "--output=%RUN%\scene.json"
set "FIXTURE_CONTROL_OUTPUT=%RUN%\controls.json"
node evidence/fixture-request-integrity-2026-11-19/controls.cjs "%ELECTRON%"
node evidence/fixture-request-integrity-2026-11-19/archive.cjs "%RUN%\scene.json" "%RUN%\controls.json" "%RUN%\publish"
```

验收分支的正式截图/计时和烘焙宿主可加 `--audit-transport`。报告的 `transportClean` 继续按原始 CDP 和 HTTP 错误判定，`transportAudit.payloadIntegrityClean` 单列逐请求收件结果。开关只影响验收宿主；两宿主各自原有的渲染、JS 或烘焙条件照常参与退出判断。
