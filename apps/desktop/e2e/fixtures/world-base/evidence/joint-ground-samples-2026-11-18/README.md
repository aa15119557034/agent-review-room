# 岛屿与街区联验 · 四区地面抽样

左列为 #254 的固定种子 252 正式基线 `f608c8ae`，右列为本地合成 `b4e134e3`（#266 `9a29c1f` 与 #254 `f608c8ae`）。两组均由 RTX 3060 Laptop / ANGLE D3D11 输出 1440 × 900 无 HUD 原生 PNG，夕照、动画时间 14 秒及 57° 垂直视角相同。[五行对照总览](ground-side-by-side.jpg)

|地面位置|#254 正式原图|两方合成原图|实拍读数与画面|
|---|---|---|---|
|E 拉克港码头|[基线](original-254/sample-e-harbour.png)|[合成](sample-e-harbour.png)|两组绝对姿态一致，贴地 1.600 m。手推车、钟楼与沿岸栏杆保持对位，海面和天空改变。|
|F 东部山麓，同一落脚点|[基线](original-254/sample-f-hillside.png)|[合成](sample-f-hillside.png)|同一平面位置与朝向，两组都贴地 1.600 m。新地表降低 13.779 m，前景草石坡遮住了基线中的远峰。|
|G 铁路北侧小路|[基线](original-254/sample-g-rail.png)|[合成](sample-g-rail.png)|绝对姿态一致，贴地 1.600 m。护栏、列车、樱树和住宅仍可辨。|
|H 北端村道|[基线](original-254/sample-h-north.png)|[合成](sample-h-north.png)|绝对姿态一致，贴地 1.600 m。灯塔与石板路保持对位，路沿植被和天空改变。|
|F 东部山麓，同一绝对机位|[基线](original-254/sample-f-hillside.png)|[合成](sample-f-absolute-254.png)|两组精确重合 XYZ、四元数、FOV。合成眼高 15.379 m，可见换过的山峰、树群与坡石。|

F 的眼点在平面坐标 (1040.6682, 591.5865)。#254 眼点 Y 为 61.5086，目标为 (1062, 102.7783, 490)。合成普通 F 的眼点 Y 为 47.729416887，目标为 (1062, 88.999116887, 490)，朝向四元数的最大舍入差为 5.6×10⁻¹⁷。第五行用采集器临时回到 #254 原姿态。

合成组经原渲染循环将天气时钟固定在 14.000 秒，海洋冷锋下的海上低云，云量 0.324398、风速 4.1601 m/s、雨量 0、雾 0、路面湿润 0。#254 原版没有 #266 动态天气系统，可对齐同一夕照和动画时刻。对照同时包含地形、植被、海陆光照与天气的差异。合成五种姿态各连拍三次，PNG 哈希在每组内一致。返回 E 的整张 PNG 与首张一致。无场景异常，WebGL 错误码为 0。网络记录中，合成组有一次浏览器取消 boulders.glb 请求，原组也记录该项及另外三次取消。原生服务的 274 条静态资源入口已单独检查可达。

在该检出的 `apps/desktop/e2e/fixtures/world-base` 运行以下命令。回放需要本机已准备的 .local 模型和贴图。捕获目录使用尚未建立的绝对路径。

```
node evidence/joint-ground-samples-2026-11-18/reproduce.cjs verify
node evidence/joint-ground-samples-2026-11-18/reproduce.cjs <Electron可执行文件> <新捕获目录>
```

[合成组姿态、天气与 SHA-256](report.json) · [原组姿态及 SHA-256](original-254/report.json) · [逐像素与姿态统计](comparison.json) · [生成对照总图](panel.py)
