# X-51 · 桜ヶ丘駅 × Petalwake

独立的世界画面试验，任务与接力约定见 [#252](https://github.com/aa15119557034/agent-review-room/issues/252#issuecomment-6918103240)。本分支从 `main` 开始，不接生产页面、世界规则、存档或契约，不导入人物。

本轮顺序：原始项目基线 → 岛上场地与车站区拼接 → 步行及可切换镜头 → 基础着色对比 → 固定机位截图、录像与性能记录。完成后由林离在 PR 发布“可精修：着色和配色”，交给 C酱，同一时间只有一人修改分支。

## 上游来源

- [Petalwake](https://github.com/jjcm/petalwake)，`25443cef0eba802052d9ef24c94ba3c4157b6f2e`，MIT；外部 AI 模型与材质另算，仅本机使用。
- [Sakuragaoka Station](https://github.com/kiarashfa/sakuragaoka)，`4112f57208b7e29998344ca71fef74202c2b2bdd`，MIT；外部字体另保留其许可。

`.local/` 存放原始下载、基线和运行素材，禁止提交。`artifacts/` 存放原始采集结果，禁止把用户配置或其他桌面应用数据放入其中。后续证据须注明源码版本、摄像机、分辨率、硬件与采样方法；作者的性能数字不作为本机实测。

## 本机准备

运行 `node scripts/prepare.cjs` 下载固定版本并核对归档及 760 个原始文件的 SHA-256。已有原始副本如被修改或不完整会报错，保留现场，不改写清单掩盖差异。需要代理时设置 `WORLD_BASE_PROXY=http://127.0.0.1:7897`。只使用系统已有的 Node、curl、tar；不安装依赖。已提交的 `upstream/` 是 MIT 源码，准备脚本不会覆盖它；`--vendor-code` 仅供首次建立副本，目标存在时会报错。

`sources.json` 登记来源、作者、commit 和归档哈希，`source-files.json` 登记每个原始文件的 SHA-256。Petalwake 的全部二进制资产及原项目副本都只在 `.local/`，不进 Git。Three.js 使用 Petalwake 固定的 r187，额外的 RoundedBoxGeometry 来自 Three.js r187，许可和哈希一并保留。

当前背景建筑登记在 [city-assets.json](./city-assets.json) 的 `projects.downtown`：Quaternius Downtown City MegaKit **免费 Standard** 的三栋完整建筑（CC0 1.0）。先从清单所列官方入口取得指定版本，再执行：

```bat
node scripts\prepare-city.cjs --downtown=<Standard解包目录>
```

脚本只复制已核对哈希的26项依赖至 `.local/city/downtown/`，不改变原文件，也不安装软件。无参数运行会复核这26项文件；组合基线启动前会自动做这次校验。已退休的 mirzaev3d 高层在 `retiredAssets.highrise` 保留官方来源、许可、原文件哈希和材质核对依据；当前准备和运行不需要其 GLB 或 OBJ 包。

在本目录使用已有 Electron 运行，无需构建桌面应用：

```bat
node scripts\baseline.cjs --scene=combined --electron=D:\codex\2026-11-16\world-implementation\runtime-path-probe\electron.exe --preview
```

去掉 `--preview` 自动采集性能、四机位截图和视频；录视频须同时指定 `--ffmpeg=<已有可执行文件>`，不会安装软件。`--output=<目录>` 指定保存处，`--stills` 跳过录像；`--video-only --video-ms=12000` 只重录四机位，不重做性能采样。录像仅采集 fixture 的 WebContents，将 CDP 画面按真实时间戳交给 FFmpeg 编码，不录桌面、不补帧或加速。原项目基线分别用 `--scene=petalwake` 和 `--scene=sakuragaoka`，默认不录视频；两者保留原 HTML、源码、默认质量和版本。原项目的 Google Fonts/CDN 默认经本机代理 7897，`--proxy=<地址>` 可修改。原项目首次加载统计包含这些网络请求，不等于纯本地场景构建时间。

## 组合场景

同一 WebGL2 renderer 和 scene 中保留 Petalwake 地形、港镇、河流、海面、云、植被，将车站放到 `(280,8,900)`，港镇在西南侧。站区核心保留原商店内景和步行碰撞，外围远景裁出，避免覆盖原岛。第一/第三人称用 V 切换，固定机位用 1–4，H 隐藏面板。

港镇色阶沿用车站明暗阈值；地形及填缝带则对已包含草地柔光校正的漫反射分成四档，避免把原始法线直接套入偏亮档位。C酱第二轮精修将站区色阶贴图改为线性插值，减弱描边，并采用选择性饱和、冷影暖光和低机位天空调色。深度来自真实位移地形的颜色 pass，避免描出错误的地形网格。低机位统一着色使用按最亮通道计算的软曲线，相机海拔 120–600m 逐渐切回 ACES；高空或关闭统一着色时使用 ACES。低机位还按深度加入远景空气透视。默认关闭运动模糊与 god rays，可单独开启对比；取消统一着色会恢复岛屿原漫反射计算，但保留公共 bloom、灯光、线性过滤的站区色阶及局部地表/水面适配，不能作为旧提交的严格对照或完全无后处理模式。

`src/main.js` 定义固定机位；`src/look.js` 是后续着色精修入口。`src/island.js`、`src/station.js` 和 `src/station-view.js` 分别负责岛屿、站区及步行镜头。未接入任何生产页面、规则、存档或契约。

## 街景补充

按 [江浩提供的11张图与C酱拆解](https://github.com/aa15119557034/agent-review-room/issues/252#issuecomment-6924488172) 复用当前底子中的现成资源，逐项来源、许可和原文件 SHA-256 见 [streetscape-assets.json](./streetscape-assets.json)。

- `src/streetscape.js`：W3低墙两只花箱、W2二层侧墙外机及支架。复用已有图集和造型；门口及既有自行车留空，低花箱按原物理台阶规则提供顶面。
- `src/skyline.js`：站区北侧两组原比例公寓，保留外廊、楼梯、阳台、院落和晾衣；台阶与小路接到原有堤顶路，按真实地形及接缝表面落地。只清理院落和连接处的草花，属于不可步行背景；没有扩大地图导航范围。释放时先调用 `worldBase.skyline.dispose()`，再释放 station，以保持借用纹理的所有权顺序。
- `src/wet-road.js`：五组局部湿区。C酱第三轮扩大湿区并调整底色与天光混合，第四轮按贴花alpha改善井盖干区；采样遵守贴图矩阵、wrap和flipY，读取失败明确报错。本机两个机位的固定帧开/关/开确认可见响应和严格恢复。当前公式只有天光近似，**没有店铺倒影**，不新增全屏pass或反射渲染目标。调试开关为 `worldBase.station.wetRoad.setEnabled(false/true)`，专用验收脚本为 `scripts/diagnose-wet-road.cjs`。

这组补充提供近景和近郊层次，尚不是参考图里的都市天际线、密集商业街或完整湿地反射效果。固定四机位之外，采集脚本另拍花箱、侧墙、背景及干湿路面细节，镜头坐标随报告保存。

`src/city.js` 当前保留三栋原比例中层作为站后候选背景，复用原贴图并按颜色空间、采样及UV语义共享相同纹理；免费版中的顶点控制色不作为门面染色，底色有局部风格适配。地基采全部双线性高度格点极值，街区铺地和道路贴实际地表，堤顶连接采过渡网格并使用台阶；只合批适配层新增的铺地、道路、地基与台阶，原建筑几何不变。背景仍不可步行，无LOD，也未实现作者收费版的假室内shader。场景释放时，先释放 city 和 skyline，再释放 station；它们借用站区渐变与道路贴图。

## 当前状态

当前三栋中层、井盖修正、资产清理与五轮交替步行对照见 [第四轮回验](./evidence/city-polish-2026-11-17/README.md)。高层已退休；固定机位约65 FPS，但最新一次第三人称57.633、第一人称65.000，步行性能仍有波动，材质与地块风格也尚未最终验收。湿面两机位严格恢复通过。资源取消复现与已知Chromium终结状态缺陷吻合，本机运行时未修复，仍保留transportClean=false。含塔楼的早期试装和失败记录见 [76a000d历史试装](./evidence/city-background-2026-11-17/README.md)。

第三轮湿面精修、正常运行GPU复测和严格干湿对照见 [9417b6e本机验收](./evidence/gpu-wet-9417b6e/README.md)。第二轮精修单独复测见 [a7fe1e7 GPU证据](./evidence/gpu-polish-a7fe1e7/README.md)；花箱、外机、公寓及湿面诊断的早期失败历史见 [街景补充与交接](./evidence/streetscape-2026-11-17/README.md)。之前的地表对照、录像及未通过的诊断限制见 [地表与浅水修正](./evidence/terrain-water-2026-11-17/README.md)；首轮录像、原版基线和性能修复历史见 [EVIDENCE.md](./EVIDENCE.md)，旧录像不代表当前场景参数。第三方许可和修改范围见 [THIRD-PARTY.md](./THIRD-PARTY.md)。
