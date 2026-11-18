# 广场樱最终版 · RTX 3060 地面验收

广场樱的树冠在站前牌楼上方露出枝梢和花簇，旧版的大块多面体轮廓已换掉。A 镜头牌楼文字范围最大 RGB 差为 [2, 1, 1]。两次独立性能采样中，第一次的 A 主街和第三人称步行未达到原目标，第二次六段全部达到。[牌楼与树冠原大对照，左 V2、右最终](plaza-crown-and-gate-1to1.png) · [两轮原始帧与采样条件](performance/comparison.json)

| 版本 | Git 提交 |
|---|---|
| 对照，Blender V2 + R3b | `eed4fb46eb7e78418fa319f6f24bdbfe654425a0` |
| 新广场树、26 枚贴花、两时段采集源 | `7ffb5a118e5e05e8f584955b67813ac383f29c99` |
| 安装两个新负 Z 面后，拍照、上传和两轮计时 | `1ea97233815bedc700751a04fe69ee7fb28b7a21` |

## 八镜

同一地面入口依次点击 A–H，然后返回 A。均为傍晚、动画时钟 14 秒、1440×900、DPR 1、隐藏界面。每镜保存连续三次抓图哈希，第三张为此处的原生 PNG。全部眼位、目标、四元数、视野角与 V2 完全相同，返回 A 的最终图像逐像素相同。每镜 GL 错误和 JS 异常均为 0。正常截图进程和独立审计复拍的原生退出码均为 0。[逐镜数据和相机姿态](photos.json) · [进程回执和复拍差异](runs.json)

| 地面机位 | V2 → 最终，变化像素 / 1,296,000 | 地面机位 | V2 → 最终，变化像素 / 1,296,000 |
|---|---:|---|---:|
| [A 主街](art-a-street.png) | 116,156 | [E 港镇码头](sample-e-harbour.png) | 5,544 |
| [B 便利店](art-b-konbini.png) | 10,492 | [F 山坡](sample-f-hillside.png) | 0 |
| [C 后巷](art-c-alley.png) | 0 | [G 铁路小路](sample-g-rail.png) | 4,403 |
| [D 洗衣店](art-d-laundry.png) | 0 | [H 北村](sample-h-north.png) | 0 |

A 的树冠和牌楼范围 [397,159,915,420) 两列均以 1:1 像素裁出。135,198 像素中有 62,720 个变化。文字区 [618,294,872,320) 的 6,604 像素中，2,370 个出现 1–2 级 RGB 差，超过 8 级的为 0。独立新进程复拍的 A/B/C/D/F/G/H 与正式 PNG 逐像素相同。E 港镇在完全相同源码与眼位下仍有 5,135 像素差异，无法把其 5,544 个跨版本差异全归因于广场樱。[四个站区机位缩略对照](station-ground.jpg) · [四个岛上地面机位缩略对照](island-ground.jpg) · [E 的独立复拍原图](transport/audit-sample-e-harbour.png)

## 倒影

街道探针位于世界坐标 (280, 10.264, 918)。冻结 14 秒分别以午后和傍晚的正式光照渲染，6 面各 256²，12 面均无负值或非有限 RGB。线性峰值超过 2 的像素按同一系数缩放三个分量，保留色相。两时段中只有负 Z 面的量化 RGB 变化，其余十个安装 PNG 保留原始文件字节。[六面数据与原始哈希](reflections/comparison.json)

| 时段 | 变化面的量化像素 | 六面限幅像素 | 限幅前最高值 | 编解码最大线性误差 |
|---|---:|---:|---:|---:|
| 午后 | 881 | 1 | 2.3984375 | 0.006733 |
| 傍晚 | 753 | 89 | 2.9394531 | 0.007643 |

每时段另开一个正常地面进程，从正在使用的 WebGL 立方体逐面附加 framebuffer 回读。12/12 面的解码后 RGBA SHA-256 与显存回读相同，每面服务器只收到一次 GET 并发回 200。正常入口里 8 个合批玻璃网格涵盖 27 扇窗，均与湿路采样同一立方体。运行时捕获和额外湿路绘制均为 0。Chromium 的 Resource Timing 缓冲只保留部分图片记录，全部面都有独立服务器完成事件和实际显存哈希。[午后实测](reflections/afternoon/uploaded.json) · [傍晚实测](reflections/evening/uploaded.json)

## 帧时

RTX 3060 Laptop、D3D11、1440×900、DPR 1。每轮新进程，四固定镜各采约 10 秒，实走各采约 3 秒。FPS 由该段总帧数除以 RAF 总时间计算，P95 取最近秩。原门槛为 FPS ≥60 且 P95 ≤16.7 ms。

| 段 | 第一轮 FPS / P95 ms | 第二轮 FPS / P95 ms | 两轮 >20 ms 帧数 |
|---|---:|---:|---:|
| A 主街 | 59.29 / 30.8 | 64.21 / 15.5 | 58 / 8 |
| B 便利店 | 64.21 / 15.5 | 62.33 / 15.6 | 8 / 27 |
| C 后巷 | 63.52 / 15.5 | 65.00 / 15.5 | 15 / 0 |
| D 洗衣店 | 65.00 / 15.5 | 65.00 / 15.5 | 0 / 0 |
| 第三人称步行 | 59.88 / 30.7 | 65.00 / 15.5 | 16 / 0 |
| 第一人称步行 | 65.00 / 15.5 | 64.68 / 15.5 | 0 / 1 |

两轮所有段均未出现超过 33 ms 的帧。第三人称实际水平距离为 9.607 / 9.419 m，第一人称为 9.563 / 9.617 m。Windows 前台采样两轮分别 0/90、0/91 位于被测进程树，六段首尾页面均自报有焦点。数值反映本次窗口和后台条件。前一版 V2 的两次主街为 63.7 / 64.1 FPS、P95 均 15.5 ms，两次第三人称为 64.7 / 62.1 FPS、P95 15.5 / 15.6 ms。两组采集时间不同。GPU 频率、负载、焦点时间、draw、三角数和逐帧数据均已保留。[逐段比较](performance/comparison.json) · [第一轮 RAF](performance/final-1.frames.json.gz) · [第二轮 RAF](performance/final-2.frames.json.gz)

## 传输与几何

两次烘焙、正式帧时两轮、独立八镜审计复拍分别出现 4、3、4、3、4 个 CDP 取消。五个进程的原始“零取消”判定均为 false。五次分别有 270、272、273、273、272 个本机 HTTP 请求逐项匹配唯一服务器回执、源文件及实传 SHA。相应的应用读逐一校验 EOF 和长度，每个取消均有同一请求实际读足并与文件相同的证明。普通截图进程另记录 4 个取消，该进程未安装逐请求哈希观察器。审计照片的首个诊断宿主漏记 loadingFailed 的事件类型，按原规则拒绝并退出 1。补齐原事件字段后的新进程正常退出 0。两个诊断的像素差异和失败闭环均保留。[原始诊断反例](transport/diagnostic-missing-event-type.json.gz) · [复拍逐请求证据](transport/photos.json.gz) · [全部进程回执](runs.json)

原生渲染复用 26 枚既有贴花的烘焙结果，规划射线为 0。CPU 重装后 26 枚贴花全部保有支撑，3,147 条碰撞与 V2 相同，W1 的 60 件商品通过底部 51,036 次承托采样。[几何、贴花与可行走检查](cpu/README.md)

## 复核与重跑

在本目录使用 Node、Python、NumPy 和 Pillow 复算。HDR 检查从 Git 取本表两个采集提交的正式 PNG，另用保存的原始半浮点与 GPU RGBA 哈希交叉校验。

```sh
node tools/verify.cjs
python tools/verify-reflections.py
node cpu/verify.cjs
```

原生重跑需要已有 Electron 和准备完成的 fixture。在另一个检出准备验收分支 `0db21d2df3ed097d4f3414539b92e8eadcc12b75` 的 fixture，设置 `AUDIT_FIXTURE` 指向其 fixture，`WORLD_FIXTURE` 指向待测源的 fixture，`TESTED_SOURCE` 取待测源码的完整 HEAD。下方 `<electron>`、`<new-output>` 均替为本机路径，每次使用新目录或新文件。V2 的上一轮照片来自 `58a46094de1ac23493f35f1bea94683df5d49c2d` 所归档的 `eed4fb46` 原生拍摄。工具的源码校验和生成宿主的语法已复核，提交中的便携入口使用相同采集步骤；本报告的数据取自本次实际运行的宿主。

```sh
node tools/bake.cjs afternoon <electron> <new-output>
node tools/bake.cjs evening <electron> <new-output>
node tools/capture.cjs on <electron> <new-absolute-output>
node tools/capture-upload.cjs <electron> afternoon <new-json-file>
node tools/capture-upload.cjs <electron> evening <new-json-file>
node tools/timing.cjs <electron> <new-artifacts-folder-name>
```

烘焙时使用 `7ffb5a11`，照片、显存回读与两次计时使用 `1ea97233`。帧时命令每调用一次建立新 Electron 进程，记录 RAF、路程、绘制负载、DOM 焦点和严格传输结果；本次另有半秒粒度的 Windows 与 Nvidia 外部监控数据保存在逐段比较中。
