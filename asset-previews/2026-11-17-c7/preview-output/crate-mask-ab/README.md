# Crate：补回官方 opacity 的同机位对照

**结果：近侧箱壁完整，细栅格能看到背景，地面阴影出现镂空透光。** 这比只改不透明更完整；不透明解决了本次箱壁遮挡异常，官方遮罩恢复了小栅格的穿透语义。小栅格依靠alpha cutout，不能称为真几何孔。

## 图片

| 状态 | 960px JPG | 1440×900 PNG |
|---|---|---|
| 原始 glTF | [01-crate-original.jpg](01-crate-original.jpg) | [原图](01-crate-original.png) |
| 不透明控制 | [02-crate-opaque-control.jpg](02-crate-opaque-control.jpg) | [原图](02-crate-opaque-control.png) |
| 官方遮罩 | [03-crate-official-mask.jpg](03-crate-official-mask.jpg) | [原图](03-crate-official-mask.png) |
| 恢复原始 | [04-crate-original-restored.jpg](04-crate-original-restored.jpg) | [原图](04-crate-original-restored.png) |

相机、灯光、曝光、环境、几何、摆放完全相同。未加AO、未改side、颜色、原贴图或其它材质补偿。

## 遮罩来源与唯一改动

官方 `plastic_crate_02.files.json` 的 **blend.1k.blend.include** 明确包含同名 `textures/plastic_crate_02_opacity_1k.png`；glTF include 则漏了该图。本次从该已观测官方URL单独下载，没有使用另一个 Alpha 图，也没有从颜色图猜遮罩。

- [原始遮罩 PNG](../../supplemental/plastic_crate_02/textures/plastic_crate_02_opacity_1k.png)
- [独立校验收据](../../supplemental/opacity-receipt.json)
- 16,785字节；官方MD5 `1b087615419b81cc55241fa7cdbe36f7` 匹配。
- 实际SHA256 `2f755d95d8c28792c54b31427523bdd5ada6ddc003762ac6d057530d224fa170`。
- IHDR：1024×1024、8-bit、PNG color type 0（灰阶），已查看实际mask，黑色细栅格对应透明部分。

在原材质的克隆上，仅设置：

```js
material.transparent = false;
material.depthWrite = true;
material.alphaMap = officialOpacity;
material.alphaTest = 0.5;
```

遮罩 `flipY=false`、`NoColorSpace`、UV channel 0；wrap/min/mag sampler与原baseColor map相同。原baseColor/normal/roughness/metalness/AO引用、side和颜色全部保持，脚本已核对同一对象引用。没有改三角面、UV或13个原始文件。

## 校验与限制

- [preview-report.json](preview-report.json)：每张相机、灯光、材质实值、请求、异常及原文件哈希。
- [comparison-check.json](comparison-check.json)：参数一致性、像素差异、补充mask哈希、PNG/运行时viewer源哈希。
- 四张WebGL error均0；无context lost；exceptions=[]、failedRequests=[]。原13文件和补充PNG均保持原字节。Electron实际退出码0，窗口/本地HTTP服务已销毁，没有残留预览进程。
- 不透明→masked：110,586个RGB通道变化，最大198/255、平均2.00451/255。原始→恢复：355个通道变化，最大2/255、平均0.00009182/255；不是逐像素零差异，不能称为完全一致的像素恢复。
- 图中透光和阴影变化已直接查看；本轮1024 shadow map及其PCF不用于证明远景细栅格稳定性。r187自动将请求的旧PCFSoftShadowMap回退为PCF，兼容警告完整保留。
- 只证明这个资产这次官方导出遗漏的局部恢复策略，不推广到其他模型。不是主场景验收、1.6m街道镜头或FPS证据。

本轮已冻结，后续是否接入由root/C酱决定。此前 [opaque-only记录](../crate-opaque-ab/README.md) 和 [初次三资产预览](../README.md) 均保留。
