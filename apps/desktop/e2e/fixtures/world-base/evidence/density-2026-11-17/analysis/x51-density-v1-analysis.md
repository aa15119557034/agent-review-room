# Density 真实素材固定图回验

精确源0d97731bd7cb4f4634f4c9fdc0e1033ae7585f2a；唯一运行session55536／PID52044，实际exit1。GPU已释放。目录：

`D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/artifacts/gpu-density-v1`

7机位×warmup／capture1／capture2，共21张原PNG与960宽JPG。固定time14、默认AO.55；六个原机位沿用C12实际相机，street-detail为新1.6m人眼近景、FOV58，没有C12同机位A/B。未做AO开关、HDR／tap、性能、步行或阴影ABA。

## 结果及正常基线边界

本定向renderOk=true，transportClean=false，仅loading阶段plastic_crate_02.bin发生ERR_ABORTED；没有JS异常或HTTP错误。source／driver／9真实assets unchanged；恢复AO、contrast、原时间、station-street／FOV58及RAF，materials／lightMaterials／shadow flags恢复记录通过。所有7组capture1／2原PNG字节一致、像素差0。

**早先正常基线gpu-town-density-v1并未通过**：session16446／PID38628实际exit1，renderOk=false，停waiting-for-ready-frame，snapshot中的Object.entries抛TypeError: Cannot convert undefined or null to object。本驱动不调用该snapshot，独立取证成功不能抵消正常基线错误，也不能代替性能／walking测量。根层后续修复及正常基线另记录。

## 原尺寸实图观察

- 服务角：双分类桶清楚，位于原箱筐旁，卷帘开口未被新桶遮住。簸箕大部分被箱筐／桶遮挡，只露小段蓝色；中心射线先命中新桶，不能说簸箕完整可见。
- 洗衣店：伞架及分类桶实际可见，中心门仍留开口，原立牌／筐／盆仍有独立轮廓。24斜视时桶有屏幕遮挡，21正面可辨两桶；没有把视锥内等同全可见或零物理相交。
- 20后廊：地面扫帚、簸箕、水桶、电表位于端部门旁，与中央钢梯分开。两包裹中心投影(643,398)/(644,387)虽在画内，射线先中近处栏板；本图未证明二层包裹清楚可见。没有加机位或隐藏栏板来挑图。
- 新street-detail：电表表面与管线清楚贴墙，相对旁边窗与长椅尺寸克制。世界相机[284.4,10.2812862745,924]、FOV58；这是新机位实际观察，不是假造C12对照。
- 01街道构图保护保持；04店内整图RGB与C12完全相同，已定位后墙ROI也相同。此次没有重做AO核验。

## C12同机位像素对照

所有六对camera／time／look params／AO一致；最终编码RGB统计如下，非线性亮度。

| 机位 | 改变像素 | meanAbsRGB | 最大通道差 |
| --- | ---: | ---: | ---: |
| 23 service-corner |112361|1.803606|70|
| 24 laundry-details |32518|.371232|137|
| 04 shop-interior |0|0|0|
| 20 rear-eye |4558|.043600|167|
| 21 front-eye |27203|.432886|93|
| 01 station-street |1468|.013635|72|

01差异>1主要位于x1124..1179/y415..533的新电表区域。完整>0/>1/>4包围框、7对重复、逐物投影与中心ray见JSON，不以全帧均值稀释局部变化。新street-detail明确标comparable=false。

## 资源与几何口径

源级只读审查：伞架纳入signRoot全树遍历，kit原几何去重后克隆，材质clone保留两个hooks并清clip，分别进入owned geometry／material集合；dispose有双调保护，不释放借用的纹理／图集。这里没有新做CPU/GPU生命周期测试。

实际city density=252GB＋192伞架=444tri，总town29553；街景新增132tri，streetscape总2424tri，实际stats报告4objects／6colliders。city与street newTexturePixels均0。源级落点核对后廊baseY+.14与走廊顶对齐，包裹相接，前侧分类桶与伞架避开中心门；物理结果仍以单独CPU／正常walking证据为准，镇边未扩大可走范围。

213项源清单、9资产清单、原报告和42图文件，以及外部驱动／numeric共53项SHA256见x51-density-v1-analysis.json.evidenceHashes。GPU、离线驱动node --check均exit0；离线实际命令exit0：

```text
node D:/codex/2026-11-16/world-implementation/handoff/x51-density-offline-analysis.cjs
```

只解码原PNG，没有修改图片。射线忽略fragment alpha／clipping，元数据中心不是物件所有可见片元；静止重复不排除移镜共面风险。没有重跑筛绿，没有修改fixture。后续source若仅改报告契约，需以其明确diff与本轮冻结清单解释复用，不能把本轮head直接改写为新head。
