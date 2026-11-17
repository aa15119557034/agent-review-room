# C13 本机真实素材复测

源：`1677ea3167905a180d8b26c48a4b0c0ffece4325`。只做一次 normal 和一次固定图；GPU 已释放，不重跑取绿。

- Normal：session 95839 / PID 5924 / **实际 exit 1**；renderOk=true，transportClean=false。menhir.glb、crate.gltf 在等待 ready 阶段 ERR_ABORTED；0 JS 异常，14 行为检查、look、真实 W 步行通过。
- 定向：session 62458 / PID 30548 / **实际 exit 1**；21 图完整、renderOk=true；menhir.glb、crate.gltf、crate.bin 取消，transportClean=false。0 JS 异常/HTTP 错误；source、driver、9 assets、restore 均 unchanged。恢复前目标与恢复后状态 SHA 相同。

## 固定图结论

7 个机位与 density 的 camera/time/params/AO 完全相同；每机位 warmup + capture1 + capture2，7 对 capture1/2 PNG 全同。只覆盖默认 AO=.55、time=14，没有 AO-off 检查。

1. **24 圆弧墙纹已去除，21 向阳墙斑未完全收净。** 原尺寸比较能见 24 从大圆弧改为稀疏暗点；21 远处 5F 向阳侧仍有明显软斑及重复分布，不能写“脏墙完全解决”。实际墙面射线 UV 约 3m/单位，map repeat=[1,1]；这是几何采样，不是 shader 唯一归因。
2. **两处 bins 色彩更收敛，盖子更暗，构图保留。** 洗衣店细节视角中部分 bin 被遮挡，不能称全部物件完整可见。cap 窄边静态图保持连续；源码缩进与静态重复相同不能代替移动视角闪烁测试。20 钢梯和阳台投影仍清楚。
3. **保护对照：04 全图相同；01 小范围变化但并非一概樱花。** 04 与 density/C12 的 PNG 字节和 RGB 都相同，后墙 ROI (270,280,160,50) 相同。01 vs density：524 像素改变，meanAbsRGB=0.0004434，max=10；>1 差异界限 x804..852,y361..390，落在远楼区域。street-detail：1322 像素，mean=0.0016152，max=9，>1 界限 x0..85,y93..131。均未见明显构图变化。

所有 7 视角的完整差异、C12 的 6 个历史同机位对照、surface rays 见 numeric JSON；street-detail 在 C12 不存在，不冒称 A/B。C12→C13 包含中间 density 增量。

## 性能与范围

Normal 初始 978 帧，64.7356 FPS，p95=15.5ms，4 帧 >20ms，最大30.9ms。四视角依次 64.9995 / 65.0016 / 64.3571 / 64.9998 FPS；third/first 64.9995 / 64.9998，全部 p95=15.5ms。接近65可能受显示同步上限；包括原计数包装开销，不据此归因材质成本。city29553tri、29materials、26geometries、13borrowedTextures、ownedTextures=0、newTexturePixels=0、textureCacheEntriesAdded=0。

## 实际命令与原证据

Normal cwd：`D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/`

```text
node scripts/baseline.cjs --scene=combined --electron=D:/codex/2026-11-16/world-implementation/runtime-path-probe/electron.exe --stills --output=artifacts/gpu-town-c13
```

定向：`node D:/codex/2026-11-16/world-implementation/handoff/x51-c13-diagnostic-gpu.cjs`

原目录：`D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/artifacts/gpu-town-c13`、`D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/artifacts/gpu-look-c13-v1/`。图片 `{view}-ao-on-capture-2.png/.jpg`；view 为 service-corner、laundry-details、shop-interior、20-rear-eye、21-front-eye、station-street、street-detail。PNG1440×900，JPG960宽。

离线重放：

```text
node D:/codex/2026-11-16/world-implementation/handoff/x51-c13-offline-analysis.cjs > D:/codex/2026-11-16/world-implementation/handoff/x51-c13-v1-numeric.json
```

实际 exit0；已有 FFmpeg 将原 PNG 解码 RGBA，未修改图片。全图 RGB 任一差异计 changedPixels，meanAbsRGB 为三通道绝对差平均，bounds 依单像素最大通道差 >0/>1/>4。driver 与分析脚本均 node --check exit0。

机器可读结果：`x51-c13-v1-analysis.json`；完整数值：`x51-c13-v1-numeric.json`；GPU driver：`x51-c13-diagnostic-gpu.cjs`；离线 driver：`x51-c13-offline-analysis.cjs`。analysis.evidenceHashes 固定报告、清单、驱动和 7 张原尺寸/小图 SHA256。所有失败保留；不是全场景最终视觉验收。
