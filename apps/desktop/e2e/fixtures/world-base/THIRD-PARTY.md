# 第三方来源与改动

完整来源、作者、固定版本及归档校验见 [sources.json](./sources.json)，每个上游原始文件的 SHA-256 见 [source-files.json](./source-files.json)。该清单记录原始上游文件，不将修改后的适配文件伪装成原版。

| 来源 | 保留的许可 | 使用与修改 |
|---|---|---|
| Jacob Miller / Petalwake | [MIT](./upstream/petalwake/LICENSE) | 复用地形、港镇、植被、海面、河流、云及 HDR 管线；terrain.js 增加站区局部高度拟合与核心裁切。组合不运行其游戏 main、任务、飞行控制和角色。 |
| kiarashfa / Sakuragaoka | [MIT](./upstream/sakuragaoka/LICENSE) | 复用站区、商店、程序化纹理、批处理和物理；trains.js、trains/car.js、vehicles/cars.js 增加默认保持上游行为的 people 开关，组合设为 false；core/physics.js 增加使用现有空间格及碰撞体的镜头球体扫掠。 |
| Three.js authors / r187 | [MIT](./upstream/petalwake/vendor/three/LICENSE) | 复用 Petalwake 所固定的 three.core/module、GLTFLoader、BufferGeometryUtils、SkeletonUtils；另从官方 r187 标签补充 RoundedBoxGeometry，SHA-256 见 sources.json。 |
| Arseny Kapoulkine / meshoptimizer 1.1 | [MIT](./upstream/petalwake/vendor/three/examples/jsm/libs/MESHOPT-LICENSE.md) | Petalwake 随附的 meshopt decoder，保留文件内版权声明，并补齐官方 v1.1 的完整许可文本及其哈希。 |

`src/look.js` 的色阶阈值、描边及阴影调色依据 Sakuragaoka 的 MIT 实现，HDR 合成复用 Petalwake 的 MIT 实现；`src/station-view.js` 的步行碰撞流程依据 Sakuragaoka Player/Physics。以上来源的版权和许可持续适用。

局部地表适配集中在 `src/transition.js`、`src/island.js` 和 `src/station.js`：填缝带与站区底土地表外缘共享 Petalwake 地表着色及纹理，植被在边缘渐变恢复。`src/look.js` 对地形已校正漫反射做四档量化，并局部调整浅水散射、远景焦散和岸边泡沫；未改写上游 `water.js`。`scripts/analyze-caustics.cjs` 直接执行固定源码中的纹理生成函数进行 CPU 分布测量，其来源仍为上述 Petalwake MIT 代码。

街景复用登记见 [streetscape-assets.json](./streetscape-assets.json)：花箱、外机、公寓及程序纹理均来自同一固定版本的 Sakuragaoka MIT 源码。`houses.js`、`shopsA.js` 各增加现有构建上下文的导出，使适配层复用已创建的材料和图集。`src/skyline.js` 直接调用原 `buildApartment`，其地形/四边形辅助函数按 `houses.js` 适配至独立几何与真实岛屿地形；`src/wet-road.js` 保留原沥青材质，借鉴原玻璃/沟渠的天光 Fresnel 思路。新支架和局部湿区 mask 在适配层生成。没有从用户参考图中提取贴图，也没有新增第三方二进制包。

Petalwake 的 `assets/` 包含上游说明的 Meshy/fal 生成模型或纹理。本 fixture 不把代码 MIT 解释成这些素材的再分发许可：完整资产仅由固定版本下载脚本放在 `.local/`。没有 VRM 或另行导入的人物资产。截图和录像是本机运行证据，不是可复用模型文件。

原项目基线保留原版 Google Fonts/CDN 请求，各字体依其 OFL 条款；组合页面使用本机系统字体，没有打包字体文件。组合保留原场景海报、地藏、达摩、玩具等环境道具，未加载行人、司机、车厢乘客或主角角色。

`.local/` 与 `artifacts/` 均忽略。后续提交的 `evidence/` 仅包含明确挑选的运行截图、录像和报告，不含上游 GLB、贴图或下载归档。
