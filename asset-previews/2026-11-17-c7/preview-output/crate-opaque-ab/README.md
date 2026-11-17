# Crate：原始 / 不透明克隆 / 恢复原始

仅验证加载策略，未改原始文件。三张相机、灯光、曝光、物体变换完全相同；克隆材质只将 `transparent=false`、`depthWrite=true`。没有AO、双面、乘色、贴图替换或其它补偿。

- [原始](01-crate-original.jpg) · [PNG](01-crate-original.png)
- [不透明克隆](02-crate-adapted-opaque.jpg) · [PNG](02-crate-adapted-opaque.png)
- [恢复原始](03-crate-original-restored.jpg) · [PNG](03-crate-original-restored.png)
- [渲染与请求报告](preview-report.json)
- [参数/像素检查](comparison-check.json)
- [CPU几何射线检查](geometry-hole-rays.json)

**结果：** 近侧箱壁在不透明克隆中恢复，原始材质恢复后又回到缺失状态。但这不能证明细栅格正确：原网格 +Z 墙的6条高度截面、X[-.23,.23]、0.5mm步长，共5,526条不做面剔除/不采纹理的射线全部击中近壁；细黑栅格不应当作真几何开孔。较高提手位置的探针能够无命中穿透，和小栅格的情况不同。

原始→恢复原始 PNG 并非逐像素完全相等：282个RGB通道有差异，最大5/255，全图平均0.0000751/255。相机/灯光/变换/记录的渲染状态、原材质均一致；没有将这种微小差异宣称为零。原始→不透明对照最大208/255、平均2.25054/255。

三个渲染均WebGL error=0，contextLost=false；exceptions与failedRequests为空；原13文件哈希前后相等。Electron实际退出码0，finally销毁窗口并关闭server。此目录保留原轮记录；后续正式opacity试验在独立的 [crate-mask-ab](../crate-mask-ab/README.md)。
