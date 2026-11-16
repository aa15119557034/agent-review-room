# 第三方来源与改动

完整来源、作者、固定版本及归档校验见 [sources.json](./sources.json)，每个上游原始文件的 SHA-256 见 [source-files.json](./source-files.json)。该清单记录原始上游文件，不将修改后的适配文件伪装成原版。

| 来源 | 保留的许可 | 使用与修改 |
|---|---|---|
| Jacob Miller / Petalwake | [MIT](./upstream/petalwake/LICENSE) | 复用地形、港镇、植被、海面、河流、云及 HDR 管线；terrain.js 增加站区局部高度拟合与核心裁切。组合不运行其游戏 main、任务、飞行控制和角色。 |
| kiarashfa / Sakuragaoka | [MIT](./upstream/sakuragaoka/LICENSE) | 复用站区、商店、程序化纹理、批处理和物理；trains.js、trains/car.js、vehicles/cars.js 增加默认保持上游行为的 people 开关，组合设为 false；core/physics.js 增加使用现有空间格及碰撞体的镜头球体扫掠。 |
| Three.js authors / r187 | [MIT](./upstream/petalwake/vendor/three/LICENSE) | 复用 Petalwake 所固定的 three.core/module、GLTFLoader、BufferGeometryUtils、SkeletonUtils；另从官方 r187 标签补充 RoundedBoxGeometry，SHA-256 见 sources.json。 |
| Arseny Kapoulkine / meshoptimizer 1.1 | [MIT](./upstream/petalwake/vendor/three/examples/jsm/libs/MESHOPT-LICENSE.md) | Petalwake 随附的 meshopt decoder，保留文件内版权声明，并补齐官方 v1.1 的完整许可文本及其哈希。 |

`src/look.js` 的色阶阈值、描边及阴影调色依据 Sakuragaoka 的 MIT 实现，HDR 合成复用 Petalwake 的 MIT 实现；`src/station-view.js` 的步行碰撞流程依据 Sakuragaoka Player/Physics。以上来源的版权和许可持续适用。

Petalwake 的 `assets/` 包含上游说明的 Meshy/fal 生成模型或纹理。本 fixture 不把代码 MIT 解释成这些素材的再分发许可：完整资产仅由固定版本下载脚本放在 `.local/`。没有 VRM 或另行导入的人物资产。截图和录像是本机运行证据，不是可复用模型文件。

原项目基线保留原版 Google Fonts/CDN 请求，各字体依其 OFL 条款；组合页面使用本机系统字体，没有打包字体文件。组合保留原场景海报、地藏、达摩、玩具等环境道具，未加载行人、司机、车厢乘客或主角角色。

`.local/` 与 `artifacts/` 均忽略。后续提交的 `evidence/` 仅包含明确挑选的运行截图、录像和报告，不含上游 GLB、贴图或下载归档。
