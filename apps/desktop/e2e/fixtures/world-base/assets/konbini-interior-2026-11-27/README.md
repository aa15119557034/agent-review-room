# ひだまりマート室内资产

三组双面货架按零食、速食和日用品分区。后墙饮料柜和便当柜、收银柜台与保温柜、门边杂志架均有独立 Blender 根节点。所用商品图案、插画和包装由同目录脚本生成。

| 节点 | 内容 |
| --- | --- |
| `gondola-a`、`gondola-b`、`gondola-c` | 商品、分类牌、货架端头、价签 |
| `back-drink-coolers` | 五跨玻璃冷柜、饮品、灯条 |
| `back-bento-case` | 便当托盘、三明治、饭团和甜点 |
| `checkout-counter` | 双收银位、读卡器、暖食柜、咖啡机 |
| `magazine-rack` | 四层杂志架和八个封面 |

GLB 使用 W1 店铺局部坐标，地面 `y = 0.30`，入口朝 `+z`，橱窗在 `+x`。在 Blender 中对应 `(x, −z, y)`。七个根节点均无额外变换。子网格按着色、包装贴图、玻璃和发光合批，在 Blender 编辑模式可用「选择相连元素」移动单件商品。玻璃有独立半透明材质。

每组货架双面各有五层，每层正面可见 38 至 46 件，高度约 10 至 18 厘米。冷柜每跨六层，每层摆 12 件瓶装、罐装或纸盒饮料。

GLB 约 2.93 MB，含 19 个图元、40,742 个三角面、4 个材质和一张 1024 × 1024 包装图集。Blender 文件已打包该图集。

## 编辑和重建

在 Blender 中打开 `konbini-interior.blend`。用材质预览查看商品贴图。保存后可手动导出 GLB，或用以下命令重新导出当前文件。

```sh
blender --background konbini-interior.blend --python-exit-code 1 --python build-konbini.py -- --export-only
```

从脚本重建网格会覆盖同名的 Blender 文件和 GLB。提供的图集可直接用于重建。修改包装稿后，可用安装了 Pillow 的 Python 重新生成图集与图集布局，然后用 Blender 5.2.2 重建。

```sh
python paint-packages.py
blender --background --factory-startup --python-exit-code 1 --python build-konbini.py
```
