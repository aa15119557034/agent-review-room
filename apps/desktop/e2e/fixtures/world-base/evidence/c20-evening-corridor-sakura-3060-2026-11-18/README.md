# 第 20 轮傍晚精修 · 后廊、樱花与 RTX 3060 回验

修后源码 `e78c52ce50205f85a4af02bfa78fb8f230b3644b`。20 真实抹灰阴面的楼梯和栏杆可分，01 樱冠直射橙红已退。03 站区仍有红橙点。[修前基准](https://github.com/aa15119557034/agent-review-room/pull/254#issuecomment-6962029063) · [C酱交回](https://github.com/aa15119557034/agent-review-room/pull/254#issuecomment-6962692420) · [源码 Windows CI](https://github.com/aa15119557034/agent-review-room/actions/runs/44188765722/job/134412228685)

## 同机位实拍

同一台 RTX 3060 Laptop、ANGLE D3D11、1440×900、DPR 1。修前是已经换入绿墙和傍晚倒影的 `41c4fa8`，修后是 C酱交回的 `e78c52c`。八个机位逐一核对了相机位置、朝向、FOV、世界和车站时刻 14、AO 0.55、太阳及后期参数。八组均取冻结后的第三张，修后的第二和第三张 PNG 散列逐组相同。

| 机位 | 修前 · 41c4fa8 | 修后 · e78c52c |
|---|---|---|
| 01 站前主街 | [![01 站前主街 修前](../laundry-hedge-evening-reflections-2026-11-18/images/01-evening.jpg)](../laundry-hedge-evening-reflections-2026-11-18/images/01-evening.jpg) | [![01 站前主街 修后](images/01-evening.jpg)](images/01-evening.jpg) |
| 20 公寓后廊 | [![20 公寓后廊 修前](../laundry-hedge-evening-reflections-2026-11-18/images/20-evening.jpg)](../laundry-hedge-evening-reflections-2026-11-18/images/20-evening.jpg) | [![20 公寓后廊 修后](images/20-evening.jpg)](images/20-evening.jpg) |
| 21 洗衣店前 | [![21 洗衣店前 修前](../laundry-hedge-evening-reflections-2026-11-18/images/21-evening.jpg)](../laundry-hedge-evening-reflections-2026-11-18/images/21-evening.jpg) | [![21 洗衣店前 修后](images/21-evening.jpg)](images/21-evening.jpg) |
| 23 维修角 | [![23 维修角 修前](../laundry-hedge-evening-reflections-2026-11-18/images/23-evening.jpg)](../laundry-hedge-evening-reflections-2026-11-18/images/23-evening.jpg) | [![23 维修角 修后](images/23-evening.jpg)](images/23-evening.jpg) |
| 24 洗衣店细节 | [![24 洗衣店细节 修前](../laundry-hedge-evening-reflections-2026-11-18/images/24-evening.jpg)](../laundry-hedge-evening-reflections-2026-11-18/images/24-evening.jpg) | [![24 洗衣店细节 修后](images/24-evening.jpg)](images/24-evening.jpg) |
| 04 便利店内 | [![04 便利店内 修前](../laundry-hedge-evening-reflections-2026-11-18/images/04-evening.jpg)](../laundry-hedge-evening-reflections-2026-11-18/images/04-evening.jpg) | [![04 便利店内 修后](images/04-evening.jpg)](images/04-evening.jpg) |
| 03 全岛鸟瞰 | [![03 全岛鸟瞰 修前](../laundry-hedge-evening-reflections-2026-11-18/images/03-evening.jpg)](../laundry-hedge-evening-reflections-2026-11-18/images/03-evening.jpg) | [![03 全岛鸟瞰 修后](images/03-evening.jpg)](images/03-evening.jpg) |
| detail 商店橱窗近景 | [![detail 商店橱窗近景 修前](../laundry-hedge-evening-reflections-2026-11-18/images/detail-evening.jpg)](../laundry-hedge-evening-reflections-2026-11-18/images/detail-evening.jpg) | [![detail 商店橱窗近景 修后](images/detail-evening.jpg)](images/detail-evening.jpg) |

## 局部证据

**20 公寓后廊。** 阴面仍有傍晚的明暗层次，黑色栏杆、楼梯踏步和墙面抹灰现在能分清。两块避开门窗的阴面抹灰共 7,800 像素，显示亮度中位数从 36.4 升到 47.7（0–255）。同一排 11 根栏杆与两侧墙面的成对亮度差从 11.3 升到 22.3。实机绑定了三套真实公寓 PBR 材质的九张 1K 图，九个请求全部 HTTP 200 并完整读入。

[![20 同机位局部](crops/20-before-after.png)](crops/20-before-after.png)

**01 站前樱花。** 直射花瓣从橙红转成浅暖粉，树枝、背光花团和亮边仍可区分。亮边更接近粉白，金色很轻。在修前树冠区域按固定条件选出的 2,346 个暖橙像素，同位置 RGB 中位数由 (226, 127, 120) 变为 (239, 145, 157)，修后仍符合该暖橙条件的有 0 个。该计数只覆盖选定区域的高光。

[![01 同机位局部](crops/01-before-after.png)](crops/01-before-after.png)

**03 航拍仍有红橙亮点。** 站区同一小块由 62 个暖亮像素降到 57 个。冻结本轮画面，只隐藏五个 `crossing-halo` 道口光晕，灯体、镜头和 bloom 保持原设置。同一区域的计数依次为 **57 → 0 → 57**，恢复后与本次开关测试首帧逐像素相同。道口光晕使用独立 ShaderMaterial，并在顶点着色器中保留远景最小屏幕尺寸。[道口光晕着色器](https://github.com/aa15119557034/agent-review-room/blob/e78c52ce50205f85a4af02bfa78fb8f230b3644b/apps/desktop/e2e/fixtures/world-base/upstream/sakuragaoka/src/world/crossing/glow.js#L23) · [本轮灯色筛选](https://github.com/aa15119557034/agent-review-room/blob/e78c52ce50205f85a4af02bfa78fb8f230b3644b/apps/desktop/e2e/fixtures/world-base/src/evening-glow.js#L13)

[![03 同机位局部](crops/03-before-after.png)](crops/03-before-after.png)

[![03 道口光晕开启、隐藏、恢复](crops/03-halos-on-off-restored.png)](crops/03-halos-on-off-restored.png)

20、01 的对照裁切保留原始像素，03 采用最近邻 4× 放大。坐标以 1440×900 原图左上角为原点。显示亮度使用 8 位屏幕 RGB 的加权值。03 单独诊断的正常帧与主截图全图有 50 个像素不同，亮点测区内为 0 个，诊断恢复帧与同轮首帧全图一致。[坐标、颜色条件与测量结果](visual-measurements.json) · [光晕诊断逐帧记录](halo-diagnostic.json)

## 帧时与运行状态

完整复测的十段均约 65.00 FPS，p95 均为 15.5 ms。3,843 帧中没有超过 20 ms 的帧。常规四机位和第一、第三人称步行各采约 3 秒，镇边四机位各约 10 秒，计时期间场景时钟正常推进。

| 机位或路线 | 修前 FPS | 修后 FPS | 修前 / 修后 p95（ms） | 修前 / 修后 >20 ms（帧） | 修后总帧 |
|---|---:|---:|---:|---:|---:|
| 20 公寓后廊 | 64.60 | 65.00 | 15.5 / 15.5 | 4 / 0 | 657 |
| 21 洗衣店前 | 65.00 | 65.00 | 15.5 / 15.5 | 0 / 0 | 657 |
| 23 维修角 | 64.60 | 65.00 | 15.5 / 15.5 | 4 / 0 | 658 |
| 24 洗衣店细节 | 65.00 | 65.00 | 15.5 / 15.5 | 0 / 0 | 657 |
| 01 站前主街 | 65.00 | 65.00 | 15.5 / 15.5 | 0 / 0 | 203 |
| 站区港口 | 65.00 | 65.00 | 15.5 / 15.5 | 0 / 0 | 202 |
| 03 全岛鸟瞰 | 62.77 | 65.00 | 15.5 / 15.5 | 7 / 0 | 203 |
| 04 便利店内 | 65.00 | 65.00 | 15.5 / 15.5 | 0 / 0 | 202 |
| 第三人称步行 | 64.68 | 65.00 | 15.5 / 15.5 | 1 / 0 | 202 |
| 第一人称步行 | 64.68 | 65.00 | 15.5 / 15.5 | 1 / 0 | 202 |

**首轮存在明显波动。** 首次从导航到场景就绪耗时 134.0 秒，整轮在 180 秒截止时停在街景拍摄，留下四段完整样本。01 主街 **36.96 FPS / p95 45.8 ms**，03 鸟瞰 **55.71 FPS / p95 30.8 ms**，两项未达到平均 ≥60 FPS、p95 ≤16.7 ms 的预算。补测仅把整轮截止时间调到 420 秒，场景在 37.4 秒就绪，画质、暖机和每段采样窗口相同。首次慢载与低帧率的根因尚未定位。

| 首轮已录机位 | FPS | p95（ms） | 最长（ms） | >20 ms / 总帧 |
|---|---:|---:|---:|---:|
| 01 站前主街 | 36.96 | 45.8 | 46.7 | 82 / 116 |
| 站区港口 | 64.36 | 15.5 | 30.8 | 2 / 200 |
| 03 全岛鸟瞰 | 55.71 | 30.8 | 30.9 | 29 / 174 |
| 04 便利店内 | 62.74 | 15.6 | 31.1 | 7 / 195 |

正常入口的 14 项行为检查、外观检查和两段步行均通过。下午入口的 01 与修前 PNG 逐字节相同。五次完成的 GPU 运行均记录了资源请求取消并以 1 退出，涉及塑料筐 glTF/bin 或两处岩石模型。首轮超时也以 1 退出，六次运行均记录 0 个 JS 异常。

## 验证入口

`node scripts/prepare-apartments.cjs` 验证九张图共 4,932,249 字节的大小、MD5、SHA-256、依赖和尺寸。`node scripts/prepare-props.cjs` 验证九份道具文件共 3,579,256 字节。两条命令均以 0 退出。常规 GPU 命令使用 `node scripts/baseline.cjs --scene=combined --stills`，指定同一 Electron 和独立输出目录。各轮完整命令、采样时间和退出码见记录。数据采集仅改用单独的观测脚本，归档提交仅含本目录。

- [相机参数、PNG 与 JPEG 散列](comparison.json)
- [十段完整与四段首轮帧时](frame-times.json)，对应 [逐帧 RAF 间隔和绘制计数](frames/)
- [GPU、九张实物贴图、真实命令与所有取消请求](runs.json)
- [源码及资产 SHA-256 清单](reports/scene-manifest.json)，以及 [完整观测报告](reports/)
