# C9 固定时间诊断：暗部已恢复，店内 AO 横带仍在

源码：`1b63536ef0dae7c9f28d92efda01b0740e9a005a`。仅运行一次；GPU 已释放。

## 结果与原始证据

- 输出：`D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/artifacts/gpu-look-c9-v1`
- 报告：`look-report.json`；完整离线分析：`D:/codex/2026-11-16/world-implementation/handoff/x51-c9-look-v1-analysis.json`
- 42 次新鲜 PNG 捕获（7 机位 × AO 0.55/0 × 预热/两帧），同时保存 960px JPEG。
- `renderOk=true`，`transportClean=false`，实际 exit 1：`plastic_crate_02_1k.gltf` 的同请求 ID `ERR_ABORTED` 保留；无 JS 异常、HTTP error。
- source、driver、9 份真实资产均未改变；恢复 AO 0.55、contrast 1.05、原时间/视角/RAF。

## 暗部：同 HDR 输入，最终像素不再归零

旧图数据来源：`D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/artifacts/gpu-shutter-c8-grade-v2/grade-report.json`（capture `00-contrast-original-capture-2`）。
新图：`D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/artifacts/gpu-look-c9-v1/service-corner-legacy-c8-ao-on-capture-2.png`。
旧/新相机完全相同。上门板 ROI `(759,360,12,18)`、下门板 ROI `(759,450,12,18)` 的 sceneRT 与 compRT 半浮点字逐字一致；C9 AO on/off 两态也一致。读取使用 Three HalfFloatType/Uint16Array 正确解码，不是将半浮点位模式当整数亮度。

| 原图点（左上原点） | C8 最终 RGB | C9 AO-on / off 最终 RGB | compRT 原线性 RGB |
|---|---|---|---|
| (763,369) | 0,0,5 | 26,31,42 / 26,31,42 | 0.007007599,0.006721497,0.007312775 |
| (762,459) | 0,0,3 | 26,31,41 / 26,31,41 | 0.008293152,0.007095337,0.006641388 |

卷帘暗纹在实际图中恢复。这支持 C9 暗部曲线修复，不能外推所有材质/场景的完整 HDR 相等；两个 ROI 也包含少量亮格，非语义分割。

## 店内：残余 AO 横带

原尺寸图：`D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/artifacts/gpu-look-c9-v1/shop-interior-ao-on-capture-2.png` 与同目录 `shop-interior-ao-off-capture-2.png`。
在 1440×900 左上原点像素中，后墙 ROI 为 x∈[270,430)、y∈[280,330)。旧/新 AO 比较时间均14、相机和 pipeline params 相等，材质未改，上传 AO 分别0.55/0。

- y=295 行平均 on−off RGB：`[-12.1125,-10.35625,-8.2875]`，该行最大单通道绝对差13。
- y=304 差收窄为约 `[-1.76875,-1.50625,-1.2125]`；y=313 又扩大为 `[-9.3125,-7.95625,-6.3875]`。
- y=322 起该段差归0；可见两条分离暗带。AO-off 墙面明显更平整。
- 上述数值是 lossless PNG 的最终编码 RGB 字节，非线性亮度；JSON 保存全部50行统计。两个 AO 状态各自 capture-1/2 完全相同。

因此不能称店内横纹全部消失。因果对照支持 AO 路径增加了横带，但仅凭图像不能唯一确定是哪个采样/法线重建分支。建议下一棒优先处理这处离散采样/空间稳定性，再做局部自发光；不以全局暖色或降强度遮盖。

## 稳定性与边界

14组重复帧有13组PNG完全相同。laundry AO-on 有1像素、1通道差1 LSB（全图 meanAbsRGB=2.57201646090535e-7）；严格整轮位级一致性为false，未放宽或重试。相机、时间、params、材质记录均一致。
21窗/信箱重影明显改善，20仍保留投影；laundry 右墙大环纹两态均在，不能混称 AO 所致。未进行性能测量，不能用本诊断解释4096阴影或道具成本。所有失败与原图均保留，未改 fixture。

离线复现：`D:/codex/2026-11-16/world-implementation/handoff/x51-c9-look-offline-analysis.cjs`，默认读取上述目录，仅 stdout 输出，既有 FFmpeg 仅解码 PNG。`node --check` 和实际执行均 exit 0；HDR、点像素、全部逐行统计、重复帧计数与 JSON 完全一致。
