# X-51 动漫化植被资产

这组资产为 X-51 自制。参考本地交接的风格化生态和街区图，提取了错开的树冠层次、大块叶色、贴地灌木和边缘草簇。图集和模型的顶点均由本目录脚本生成。

- 阔叶 A/B 有独立的冠形、分叉与远景模型。
- 针叶保留倾斜侧枝和不规则的透空，近、远景使用同一组顶点色。
- 两种灌木、树篱和两种弯叶草是可分别铺放的地表资产。连续短草底由场景按站区地面生成。
- Blender 源文件用 Z 向为高，GLB 用 Y 向为高，原点在脚下。尺寸、面数和叶片裁切见 [asset-report.json](./asset-report.json)，场景登记见 [props-veg.json](../../src/props-veg.json)。
- [station-foliage.blend](./station-foliage.blend) 是可编辑的 Blender 源文件。打开后的 Overview 是展示排布，从场景下拉框切到对应资产名可直接编辑原点处的网格、顶点色和材质。图集打包在源文件内。

## 编辑后导出

保存 `station-foliage.blend` 后，在本目录运行下面的命令。每个资产场景导为同名 GLB，保留顶点色。脚本给叶片材质写入 `MASK` 和 `alphaCutoff=0.5`。加载时用近景高度对齐远景。

```text
blender --background station-foliage.blend --python-exit-code 1 --python build-foliage.py
```

## 从脚本重建源文件

这个操作会覆盖同目录的源文件。第一条命令用 Pillow 重画图集，第二条命令用 Blender 重建网格和材质。

```text
python paint-sprays.py
blender --background --factory-startup --python-exit-code 1 --python build-foliage.py -- --build-source
```
