# 第三方来源与改动

交换所、巷后工房和洗衣店门翼由 station-art contributors 在 Blender 中建模，以 MIT 许可分发。两棵樱花沿用 Sakuragaoka `4112f57208b7e29998344ca71fef74202c2b2bdd` 的树种、树干、树皮与相应元数据，花冠和花枝经项目改作。发行 ZIP 中的 `station-art-notices/THIRD-PARTY.md` 记录美术来源，`station-art-notices/licenses/` 保留原作者与改作者许可。四个 GLB 的图像和几何均嵌入各自文件。Kenney 西侧楼的单独比选可独立进行。[站区运行包](./assets/station-art/station-art-fixture.zip) · [Sakuragaoka 许可](./upstream/sakuragaoka/LICENSE)

完整来源、作者、固定版本及归档校验见 [sources.json](./sources.json)，每个上游原始文件的 SHA-256 见 [source-files.json](./source-files.json)。该清单记录原始上游文件，不将修改后的适配文件伪装成原版。

| 来源 | 保留的许可 | 使用与修改 |
|---|---|---|
| Jacob Miller / Petalwake | [MIT](./upstream/petalwake/LICENSE) | 复用地形、港镇、植被、海面、河流、云及 HDR 管线；terrain.js 增加站区局部高度拟合与核心裁切。组合不运行其游戏 main、任务、飞行控制和角色。 |
| kiarashfa / Sakuragaoka | [MIT](./upstream/sakuragaoka/LICENSE) | 复用站区、商店、程序化纹理、批处理和物理；trains.js、trains/car.js、vehicles/cars.js 增加默认保持上游行为的 people 开关，组合设为 false；core/physics.js 增加使用现有空间格及碰撞体的镜头球体扫掠。 |
| Three.js authors / r187 | [MIT](./upstream/petalwake/vendor/three/LICENSE) | 复用 Petalwake 所固定的 three.core/module、GLTFLoader、BufferGeometryUtils、SkeletonUtils；另从官方 r187 标签补充 RoundedBoxGeometry，SHA-256 见 sources.json。 |
| Arseny Kapoulkine / meshoptimizer 1.1 | [MIT](./upstream/petalwake/vendor/three/examples/jsm/libs/MESHOPT-LICENSE.md) | Petalwake 随附的 meshopt decoder，保留文件内版权声明，并补齐官方 v1.1 的完整许可文本及其哈希。 |
| Fabi_G / Plastic Crate 02 | [CC0 1.0](https://polyhaven.com/license) | [官方来源](https://polyhaven.com/a/plastic_crate_02)。glTF、BIN及贴图保持官方原字节；原导出遗漏独立Opacity，按同款blend清单补齐。适配层仅克隆材质接官方alphaMap、alphaTest=0.5、关闭混合并写深度；保留原尺度、色因子、法线和其他贴图。 |
| Dimitrios Savva / Worn Shutter | [CC0 1.0](https://polyhaven.com/license) | 工具棚卷帘与公寓金属构件使用三张 1K 原图。颜色图使用 sRGB，GL 法线与 ARM 使用线性值。[官方来源](https://polyhaven.com/a/worn_shutter) |
| Rob Tuytel / White Plaster 02 | [CC0 1.0](https://polyhaven.com/license) | 公寓外墙使用原始漫反射、GL 法线和 ARM 贴图。[官方来源](https://polyhaven.com/a/white_plaster_02) |
| Charlotte Baglioni / Rectangular Facade Tiles | [CC0 1.0](https://polyhaven.com/license) | 公寓立面与阳台使用原始漫反射、GL 法线和 ARM 贴图。[官方来源](https://polyhaven.com/a/rectangular_facade_tiles) |
| Quaternius / Downtown City MegaKit Standard（历史试装，已退休） | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)；原 License_Standard.txt 随本地历史文件保留 | [作者来源](https://quaternius.com/packs/downtowncitymegakit.html)。当前场景不再加载三栋免费版建筑；试装曾关闭顶点控制色、调整底色并共享兼容纹理，原二进制始终未改。26项原文件哈希、许可和旧截图保留于 retiredAssets.downtown 及历史证据。 |
| mirzaev3d / High-Rise Building #01（历史试装，已退休） | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | [作者来源](https://www.fab.com/listings/ca10b839-7882-42f8-ab60-496610708a6c)。当前场景不加载该模型；保留作者[原MTL文本](./upstream/mirzaev-highrise/High-Rise-Building.mtl)及旧试装证据。旧试装使用官方GLB原始几何，按MTL及Three r187 MTLLoader的Phong/sRGB约定恢复三种材质颜色与高光，并增加摆放、地基与道路。来源、哈希与历史恢复参数保留于 city-assets.json 的 retiredAssets.highrise。未声称作者为本项目背书。 |

`src/look.js` 的色阶阈值、描边及阴影调色依据 Sakuragaoka 的 MIT 实现，HDR 合成复用 Petalwake 的 MIT 实现；`src/station-view.js` 的步行碰撞流程依据 Sakuragaoka Player/Physics。以上来源的版权和许可持续适用。

新增9个道具文件的官方URL、作者、size、MD5及SHA256见 [prop-assets.json](./prop-assets.json)。原文件只保存于 `.local/textured-props/`；没有复制官网预览图或从用户参考图提取贴图。原Painted Wooden Bench因造型偏复古未接入运行。现成纸箱、矮牌和花盆继续复用桜ヶ丘MIT构件；工具棚门按原完整包围范围精确匹配后局部换材质，未改上游几何或全局共享材质。

局部地表适配集中在 `src/transition.js`、`src/island.js` 和 `src/station.js`：填缝带与站区底土地表外缘共享 Petalwake 地表着色及纹理，植被在边缘渐变恢复。`src/look.js` 对地形已校正漫反射做四档量化，并局部调整浅水散射、远景焦散和岸边泡沫；未改写上游 `water.js`。`scripts/analyze-caustics.cjs` 直接执行固定源码中的纹理生成函数进行 CPU 分布测量，其来源仍为上述 Petalwake MIT 代码。

街景复用登记见 [streetscape-assets.json](./streetscape-assets.json)：花箱、外机、公寓及程序纹理均来自同一固定版本的 Sakuragaoka MIT 源码。`houses.js`、`shopsA.js` 各增加现有构建上下文的导出，使适配层复用已创建的材料和图集。`src/skyline.js` 直接调用原 `buildApartment`，其地形/四边形辅助函数按 `houses.js` 适配至独立几何与真实岛屿地形；`src/wet-road.js` 保留原沥青材质，借鉴原玻璃/沟渠的天光 Fresnel 思路。新支架和局部湿区 mask 在适配层生成。没有从用户参考图中提取贴图。

`src/city-apartments.js` 的多层公寓沿用 Sakuragaoka MIT `houses/apartment.js` 的构造方式与 `buildWindow`、`GB` / `Frame`、阳台晾衣和道具，增加真实楼层、屋顶设施及首层店面；`src/city.js` 复用同套背景构建上下文、远景住宅、材质和图集，负责独立摆放、道路、地基及资源释放。第6轮使用同套程序化绿篱／灌木、墙色和错位退界；店面清玻璃从原玻璃另克隆独立uniforms并由city释放，新增植栽清除范围避免与原生花草叠加。没有从用户参考图中提取贴图，也没有新增外部城市贴图。

已退休候选的作者、许可依据、原包及每项文件哈希见 [city-assets.json](./city-assets.json)。`.local/city/downtown/` 的26项历史文件保持官方原字节；它们和高层GLB/OBJ包都不再是准备或运行依赖。1218字节原MTL文本继续作为有署名和许可的历史核对依据保存，旧截图与资源传输报告不改写。图像内存估计不等于GPU实测；试装材质与场景截图属于修改后效果，不能当作作者原始展示。当前不包含付费Source版本的引擎项目或shader。

Petalwake 的 `assets/` 包含上游说明的 Meshy/fal 生成模型或纹理。本 fixture 不把代码 MIT 解释成这些素材的再分发许可：完整资产仅由固定版本下载脚本放在 `.local/`。没有 VRM 或另行导入的人物资产。截图和录像是本机运行证据，不是可复用模型文件。

原项目基线保留原版 Google Fonts/CDN 请求，各字体依其 OFL 条款；组合页面使用本机系统字体，没有打包字体文件。组合保留原场景海报、地藏、达摩、玩具等环境道具，未加载行人、司机、车厢乘客或主角角色。

`.local/` 与 `artifacts/` 均忽略。后续提交的 `evidence/` 仅包含明确挑选的运行截图、录像和报告，不含上游 GLB、贴图或下载归档。

第15轮在上述固定MIT套件内增加稀疏立面生活物：外机、少量晾衣、金属顶栏、雨管／短檐沟、电表和姓氏牌；服务角复用已有百叶、职员贴纸和排水图集。逐项源码哈希见 streetscape-assets.json。洗衣店文字“さくら コインランドリー”“洗濯・乾燥”“セルフサービス”为本场景生成的虚构店招与功能说明，绘入既有第5页商店图集的空区；更新像素但没有新增纹理对象、图集页或像素容量。沿用原绘字函数和系统字体，不打包字体、不复制参考图、不声称原作者提供了此店铺。隐藏面删减仅适配层几何；上游文件保持。

X-51 美术第1轮（art r1）：新增的备货、摊位、幟旗、洗衣店贴纸、铁丝网、纸箱、管线、小货车均为程序生成（几何与画布纹理），没有引入新的第三方资产，没有下载文件，参考图只放在被忽略的 `.local/`，`evidence/art-r1/` 仅含「上一轮｜这一轮」对比图。
