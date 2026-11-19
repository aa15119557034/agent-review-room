# r11 + r10c 真机验收（3060，2026-11-20）

改前 `b4abad9`（r9d）/ 改后 `1d9f4b9`（r11 + r10c）。`1d9f4b9` 相对 `a003a27` 只改了文档，渲染代码相同。

## 环境与口径

| 项 | 值 |
|---|---|
| 机器 | RTX 3060 Laptop（12288 MiB），驱动 617.14 |
| 渲染路径 | 原生 Electron 44.9.0，ANGLE + D3D11（`vs_5_0 ps_5_0`） |
| 输出尺寸 | **1440 × 900**，DPR 1（`renderer.setPixelRatio(1)` + `setSize(1440,900,false)`） |
| 渲染方式 | **离屏**（`offscreen: true`，窗口不显示、不占桌面） |
| 时钟 | 黄昏固定时钟 `?time=evening` |
| 帧时口径 | 每帧 GPU 合计时间 P95 ≤ 16.7 ms，预热 60 帧，每轮 3 次取中位 |

### 为什么离屏也能截图

`preload-capture.js` 在页面脚本之前把 `preserveDrawingBuffer` 强制打开，否则 three.js 默认 false，合成后画布被清空，`toDataURL` / `readPixels` 只能拿到黑图。

### 为什么要确定性时钟 + 种子随机

场景里有风、水面、樱吹雪等动画，两次独立运行的时间相位不同会让逐像素比对全部失效。`preload-capture.js` 把 `requestAnimationFrame` 换成固定步长虚拟时钟、把 `Math.random` 换成固定种子，两次运行才可比。

### 噪声底（同一份代码拍两次）

| 机位 | 噪声底 |
|---|---|
| A 主街 / B 便利店 / C 后巷 / F 山坡 | **0.000%** |
| D 洗衣店 | 0.058% |
| G 铁路 | 0.386% |
| E 港镇 | 2.857% |
| H 北端 | 12.273% |

E、H 仍有跨运行抖动（未查清来源），这两处的整图逐像素结论不可靠；B 接缝、D 室内这类局部区域在噪声底 0 的机位上，结论可用。

## 复跑方法

```powershell
# 1) 两份检出各起一个静态服务（改前 / 改后）
cd <base>\apps\desktop\e2e\fixtures\world-base; node scripts/art-preview.cjs serve 4174
cd <cand>\apps\desktop\e2e\fixtures\world-base; node scripts/art-preview.cjs serve 4173

# 2) 截图（地址走环境变量：命令行里带 URL 会让 Electron 起不来）
Remove-Item env:ELECTRON_RUN_AS_NODE
$env:X51_TARGET='http://127.0.0.1:4174/?time=evening'
electron tools/x51-capture.cjs --label base
$env:X51_TARGET='http://127.0.0.1:4173/?time=evening'
electron tools/x51-capture.cjs --label cand

# 3) 逐像素比对
python tools/x51-diff.py --shots <shots目录> --summary <shots目录>/cand-summary.json

# 4) 帧时（每帧 GPU 合计 P95）
python tools/summarize-p95.py
```

## 本次结论摘要

- **帧时**：8 机位中 5 个未达 16.7 ms（A 19.08 / B 18.89 / C 17.27 / E 20.62 / G 23.33），但**基线同样未达**（A 20.03 / B 18.29 / C 16.81 / E 19.69 / G 23.19），差值都在 ±1 ms 内 —— 是既有问题，不是这一轮引入的。
- **B 平台接缝**：斜切硬边消失，改为 0.25 m 小格；但格子之间出现细暗缝。区域亮度 +0.074，65% 像素变化。
- **D 洗衣店**：门内亮度 +0.12，67% 像素变化，新增 336 个近白像素（符合"洗衣机读成白色"）。
- **其他机位**：A 0.36% / C 0.27% / G 1.80% / F 32.91% / H 16.94%；其中 **F 山坡 33% 是草地整层变化**，噪声底为 0，需要确认是否有意。
- **W1 #16 浮空**：**已修复**，几何实测：改前光斑 Y=8.4659、地面 Y=8.2742，**离地 0.1917 m**；改后光斑 Y=8.2971，**离地 0.0229 m**（= 设计上的 0.008 + 0.012 抬升）。改前值与林离报的 0.192 m 吻合。同一片光斑的实例数从 104 变为 **2558**，与「共 2,558 格」的声称一致。

## 文件说明

| 文件 | 内容 |
|---|---|
| `diff-report.json` | 每机位变化像素数、占比、最大通道差、近白像素统计、区域明细 |
| `diff-*.png` | 差异热力图（×8 放大） |
| `overlay-*.png` | 变化像素叠红在候选图上 |
| `crop-B-seam.png` / `zoom-B-seam.png` | B 平台接缝 左改前 / 右改后 |
| `crop-D-indoor.png` | D 洗衣店门内 |
| `crop-W1-*.png` | W1 投影点附近 |
| `real-?p95-*.json` | 帧时原始数据（每机位每轮） |
| `tools/` | 采集、比对、汇总脚本 |

