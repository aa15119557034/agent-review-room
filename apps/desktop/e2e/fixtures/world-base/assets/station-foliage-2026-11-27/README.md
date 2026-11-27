# X-51 动漫化植被资产

这组资产为 X-51 自制。参考本地交接的风格化生态和街区图，提取了错开的树冠层次、大块叶色、贴地灌木和边缘草簇。图集和模型的顶点均由本目录脚本生成。

- 阔叶 A/B 由沿原枝干分布的圆润团块连成闭合冠层，外缘各融合四组小叶团。远景简化后取近景代理面的法线。
- 针叶由偏斜主冠和低枝构成连续实体，近、远景取同一个高精度圆滑代理面的法线。
- 两种灌木、树篱和两种弯叶草是可分别铺放的地表资产。连续短草底由场景按站区地面生成。
- Blender 源文件用 Z 向为高，GLB 用 Y 向为高，原点在脚下。尺寸、面数和叶片裁切见 [asset-report.json](./asset-report.json)，场景登记见 [props-veg.json](../../src/props-veg.json)。
- [station-foliage.blend](./station-foliage.blend) 是可编辑的 Blender 源文件。打开后的 Overview 是展示排布，从场景下拉框切到对应资产名可直接编辑原点处的网格、顶点色和材质。图集打包在源文件内。

## 编辑后导出

保存 `station-foliage.blend` 后，在本目录运行下面的命令。每个资产场景导为同名 GLB，保留顶点色和自定义法线。脚本给带图集的材质写入 `MASK` 和 `alphaCutoff=0.5`。加载时用近景高度对齐远景。标记为 `stationCrown` 的网格通过圆滑法线选择三档树冠色，枝干使用场景常规光照。

```text
blender --background station-foliage.blend --python-exit-code 1 --python build-foliage.py
```

## 从脚本重建源文件

这个操作会覆盖同目录的源文件。第一条命令用 Pillow 重画图集，第二条命令用 Blender 重建网格和材质。

```text
python paint-sprays.py
blender --background --factory-startup --python-exit-code 1 --python build-foliage.py -- --build-source
```

## 港镇行道树和岛上樱花

[street-crowns.blend](./street-crowns.blend) 另有两个场景。行道树和岛上散布樱花保留旧 GLB 的原始枝干、尺寸和原点。行道树为 516 个三角面，较小的叶团沿枝尖错开，两条新增的细枝从树冠下露出。岛上樱花为 388 个三角面，树冠由重叠的圆润叶团构成。

要从旧资产和树冠配方重建可编辑源文件与 GLB，运行下面第一条命令。手工编辑并保存后，用第二条命令只重新导出 GLB。

```text
blender --background --factory-startup --python-exit-code 1 --python build-street-crowns.py -- --build-source
blender --background street-crowns.blend --python-exit-code 1 --python build-street-crowns.py
```

## R4 轨旁叶枝

[rail-leaf-sprays.blend](./rail-leaf-sprays.blend) 里可编辑三种叶枝，共 17 片叶。每片叶以有厚度的闭合网格建模，叶缘、弧面和隆起的中脉由几何定义。顶点色区分暖绿叶面、冷绿叶背和叶脉。GLB 共 1,672 个三角面，三个网格的局部原点各在枝条基部。场景沿两丛低灌木的肩部摆放短叶枝，保留团块轮廓。

保存编辑结果后，运行第一条命令重新导出 GLB。第二条命令从配方重建 `.blend` 和 `.glb`。

```text
blender --background rail-leaf-sprays.blend --python-exit-code 1 --python build-rail-leaf-sprays.py
blender --background --factory-startup --python-exit-code 1 --python build-rail-leaf-sprays.py -- --build-source
```
