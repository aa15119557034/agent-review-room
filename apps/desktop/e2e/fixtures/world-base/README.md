# X-51 · 桜ヶ丘駅 × Petalwake

同步美术分支上的真实贴图、Blender 源文件与本地预览见 [C酱地面美术工作副本](./assets/art-preview/README.md)。

独立的世界画面试验，任务与接力约定见 [#252](https://github.com/aa15119557034/agent-review-room/issues/252#issuecomment-6918103240)。本分支从 `main` 开始，不接生产页面、世界规则、存档或契约，不导入人物。

本轮顺序：原始项目基线 → 岛上场地与车站区拼接 → 步行及可切换镜头 → 基础着色对比 → 固定机位截图、录像与性能记录。完成后由林离在 PR 发布“可精修：着色和配色”，交给 C酱，同一时间只有一人修改分支。

## 上游来源

- [Petalwake](https://github.com/jjcm/petalwake)，`25443cef0eba802052d9ef24c94ba3c4157b6f2e`，MIT；外部 AI 模型与材质另算，仅本机使用。
- [Sakuragaoka Station](https://github.com/kiarashfa/sakuragaoka)，`4112f57208b7e29998344ca71fef74202c2b2bdd`，MIT；外部字体另保留其许可。

`.local/` 存放原始下载、基线和运行素材，禁止提交。`artifacts/` 存放原始采集结果，禁止把用户配置或其他桌面应用数据放入其中。后续证据须注明源码版本、摄像机、分辨率、硬件与采样方法；作者的性能数字不作为本机实测。

## 本机准备

站区的两棵老樱花、东侧交换所、后巷工房和洗衣店门翼来自项目的 Blender 交付包。`node scripts/prepare.cjs` 会用本检出的发行归档准备这四个 GLB。只准备本站区模型可离线运行 `node scripts/prepare-station-art.cjs`，用 `--verify` 可重新核对归档、模型、清单与许可。各版本分别安装在 `.local/station-art-releases/<SHA-256>/`。组合场景采集时将归档和逐文件哈希写入 `source-manifest.json`。[运行包](./assets/station-art/station-art-fixture.zip) · [发行 SHA-256](./assets/station-art/station-art.sha256) · [来源和许可](./THIRD-PARTY.md)

运行 `node scripts/prepare.cjs` 下载固定版本并核对归档及 760 个原始文件的 SHA-256。已有原始副本如被修改或不完整会报错，保留现场，不改写清单掩盖差异。需要代理时设置 `WORLD_BASE_PROXY=http://127.0.0.1:7897`。只使用系统已有的 Node、curl、tar；不安装依赖。已提交的 `upstream/` 是 MIT 源码，准备脚本不会覆盖它；`--vendor-code` 仅供首次建立副本，目标存在时会报错。

`sources.json` 登记来源、作者、commit 和归档哈希，`source-files.json` 登记每个原始文件的 SHA-256。Petalwake 的全部二进制资产及原项目副本都只在 `.local/`，不进 Git。Three.js 使用 Petalwake 固定的 r187，额外的 RoundedBoxGeometry 来自 Three.js r187，许可和哈希一并保留。

当前背景建筑复用站区已有的 MIT 程序化构件与纹理，不需要另行下载城市模型。[city-assets.json](./city-assets.json) 保留前两组候选的来源、许可和固定哈希：Quaternius Downtown City MegaKit **免费 Standard** 三栋完整楼（CC0 1.0）和 mirzaev3d 高层（CC BY 4.0）均在 `retiredAssets`。

已有历史文件可以显式做只读核验：

```bat
node scripts\prepare-city.cjs --retired=downtown
node scripts\prepare-city.cjs --retired=highrise
```

该脚本只核验本机已保存的历史文件，不下载或复制。组合基线不调用它，也不需要 `.local/city/`；原候选二进制、许可、材质核对依据和失败记录仍保留。

当前带纹理道具还需按 [prop-assets.json](./prop-assets.json) 准备9个官方原文件，共3,579,256字节：周转箱glTF/BIN/三图及官方独立Opacity、卷帘三图。可用已有候选副本，或从清单固定URL下载：

```bat
node scripts\prepare-props.cjs --source=D:/codex/2026-11-16/world-implementation/asset-candidates/textured-props
node scripts\prepare-props.cjs --download
```

两种方式择一；无参数只核验现存文件。size、官方MD5、SHA256、路径范围和glTF依赖闭包均会检查；坏文件和未完成的.part保留并明确报错，不覆盖。素材只放在忽略的 `.local/textured-props/`，组合基线启动前再逐个核验，实际文件哈希写入采集清单。

三栋公寓使用 Poly Haven 的抹灰、外墙砖和金属贴图。首次准备运行 `node scripts/prepare-apartments.cjs --download`，已有文件可运行 `node scripts/prepare-apartments.cjs` 核验。9 张原图共 4,932,249 字节，存放在 `.local/apartment-surfaces/`。每张图的作者、来源、尺寸以及 MD5 和 SHA-256 见 [公寓贴图清单](./apartment-assets.json)。

主街橱窗与积水共用当前时段的六面街景。默认傍晚从 `src/street-env-evening/` 读取，下午从 `src/street-env/` 读取。更改建筑或日照后，运行 `node scripts/bake-street-reflections.cjs --electron=<已有Electron路径> --output=<新目录>` 可生成新的六面 PNG 和逐面报告。默认烘焙傍晚站区与程序天空，排除道口的镜头光晕。线性 RGB 峰值超过 2 的像素按同一比例缩放三个通道，报告分别记录原始峰值、限幅数量及量化误差。

默认是傍晚（太阳高 12°、方位 280°，参数在 `src/evening.json`）。地形的太阳阴影烘焙在 `light.png` 里，换太阳必须一起重烘：首次运行 `python3 scripts/bake-evening-light.py`（需要 numpy、numba、scipy、Pillow，约半分钟），在 `.local/petalwake-*/assets/terrain/` 生成 `light-evening.png`；只换 R 通道（太阳阴影），AO、岸距、陡度照抄原图。网址加 `?time=afternoon` 回到 Petalwake 原来的下午光照做对照。港镇阴影图在场景启动时按所选太阳方向生成。

在本目录使用已有 Electron 运行，无需构建桌面应用：

```bat
node scripts\baseline.cjs --scene=combined --electron=D:\codex\2026-11-16\world-implementation\runtime-path-probe\electron.exe --preview
```

去掉 `--preview` 自动采集性能、四机位截图和视频；录视频须同时指定 `--ffmpeg=<已有可执行文件>`，不会安装软件。`--output=<目录>` 指定保存处，`--stills` 跳过录像；`--video-only --video-ms=12000` 只重录四机位，不重做性能采样。录像仅采集 fixture 的 WebContents，将 CDP 画面按真实时间戳交给 FFmpeg 编码，不录桌面、不补帧或加速。原项目基线分别用 `--scene=petalwake` 和 `--scene=sakuragaoka`，默认不录视频；两者保留原 HTML、源码、默认质量和版本。原项目的 Google Fonts/CDN 默认经本机代理 7897，`--proxy=<地址>` 可修改。原项目首次加载统计包含这些网络请求，不等于纯本地场景构建时间。

## 组合场景

同一 WebGL2 renderer 和 scene 中保留 Petalwake 地形、港镇、河流、海面、云、植被，将车站放到 `(280,8,900)`，港镇在西南侧。站区核心保留原商店内景和步行碰撞，外围远景裁出，避免覆盖原岛。第一/第三人称用 V 切换，固定机位用 1–6，H 隐藏面板。5/6为服务角和店前细节的1.6m固定检查镜头；镇边仍不可步行。性能/视频继续使用原四机位，新细节图在全部性能与走路测量后采集。

港镇色阶沿用车站明暗阈值；地形及填缝带则对已包含草地柔光校正的漫反射分成四档，避免把原始法线直接套入偏亮档位。C酱第二轮精修将站区色阶贴图改为线性插值，减弱描边，并采用选择性饱和、冷影暖光和低机位天空调色。深度来自真实位移地形的颜色 pass，避免描出错误的地形网格。低机位统一着色使用按最亮通道计算的软曲线，相机海拔 120–600m 逐渐切回 ACES；高空或关闭统一着色时使用 ACES。低机位还按深度加入远景空气透视。默认关闭运动模糊与 god rays，可单独开启对比；取消统一着色会恢复岛屿原漫反射计算，但保留公共 bloom、灯光、线性过滤的站区色阶及局部地表/水面适配，不能作为旧提交的严格对照或完全无后处理模式。

`src/main.js` 定义固定机位；`src/look.js` 是后续着色精修入口。`src/island.js`、`src/station.js` 和 `src/station-view.js` 分别负责岛屿、站区及步行镜头。未接入任何生产页面、规则、存档或契约。

## 街景补充

按 [江浩提供的11张图与C酱拆解](https://github.com/aa15119557034/agent-review-room/issues/252#issuecomment-6924488172) 复用当前底子中的现成资源，逐项来源、许可和原文件 SHA-256 见 [streetscape-assets.json](./streetscape-assets.json)。

- `src/streetscape.js`：W3低墙两只花箱、W2二层侧墙外机及支架。复用已有图集和造型；门口及既有自行车留空，低花箱按原物理台阶规则提供顶面。
- `src/skyline.js`：站区北侧两组原比例公寓，保留外廊、楼梯、阳台、院落和晾衣；台阶与小路接到原有堤顶路，按真实地形及接缝表面落地。只清理院落和连接处的草花，属于不可步行背景；没有扩大地图导航范围。释放时先调用 `worldBase.skyline.dispose()`，再释放 station，以保持借用纹理的所有权顺序。
- `src/wet-road.js`：五组局部湿区。C酱第三轮扩大湿区并调整底色与天光混合，第四轮按贴花alpha改善井盖干区；采样遵守贴图矩阵、wrap和flipY，读取失败明确报错。本机两个机位的固定帧开/关/开确认可见响应和严格恢复。湿路与橱窗采样同一张街景立方体贴图，无需额外的运行时反射渲染。调试开关为 `worldBase.station.wetRoad.setEnabled(false/true)`，专用验收脚本为 `scripts/diagnose-wet-road.cjs`。

这组补充提供近景和近郊层次，尚不是参考图里的都市天际线、密集商业街或完整湿地反射效果。固定四机位之外，采集脚本另拍花箱、侧墙、背景及干湿路面细节，镜头坐标随报告保存。

`src/city.js` 与 `src/city-apartments.js` 用站区现有 `GB` / `Frame`、门窗图集、材质和公寓构件搭建3／4／5层日式公寓，保持真实层高，合批阳台、外廊、楼梯、屋顶设施及小店；低层住宅和连续小路衔接镇边。它们属于不可步行背景，不扩展物理或修改地形，不调整全局光照、曝光和后期。场景释放时，先释放 city 和 skyline，再释放 station，以保护借用纹理。

## 墙面／物体做旧（第22轮）

`src/weathering.js` 把一个共享的做旧着色补丁套到不透明静态材质上（建筑墙面、矮墙、台阶、地基、招牌框；不碰玻璃、发光灯具、植物、地形、列车）。每个被改的材质都先 clone 成本模块自己的副本再挂补丁，`dispose()` 把网格换回原材质。参数全部在 `src/weathering.json`，`timeScale` 区分傍晚／下午。

- 墙根变脏：按「世界高度 − 地面高度」0～0.8m 渐变压暗并偏暖褐／绿灰。地面高度来自启动时烘的一张半精度高度贴图（站区取 `ctx.L.heightAt`，镇区取地形，并把公寓地基顶面盖进去）。
- 雨痕：沿墙方向 3.4 条／米的竖条噪声，竖向拉长，从每层楼板线（周期 2.85m）往下指数变淡，只压暗约 26%×噪声。
- 斑驳：世界坐标低频＋中频噪声调明度、冷暖偏色、饱和度，另有极轻的下暗上亮竖向渐变；7 栋楼各有一个 seed（公寓、低层住宅、天际线公寓的占地矩形表）。
- 转角磨亮：`fwidth(vNormal)` 找凸棱，亮度 +12%、去饱和 25%，22～60m 渐隐。
- 海报／贴纸／涂鸦：`src/weathering-decals.js`，画布程序生成一张 1024² 图集，射线检测找平整空墙后合并成一个网格（1 次 draw call，`polygonOffset` + 7mm 离墙）。不含任何游戏素材。

`?weathering=off` 关闭补丁与贴花做前后对照；`worldBase.weathering.setEnabled()` 同理。固定机位截图脚本见 `evidence/c-weathering/shot.cjs`。

## 占位体块：主街加密与远景天际线（第23轮）

`src/massing.js` + `src/massing.json` 用程序化方盒子先把布局、高度和构图定下来，之后汐的 Blender 楼块按「槽位」一块块替换。两层：`tower`（远景，25–80 m，1–3 段收分、屋顶设备、水箱、屋顶招牌，傍晚带稀疏亮窗；离主街 ≥120 m，不在 `station.bounds` / `walkExtra` 内、不在水上）和 `facade`（3–6 层，补主街两侧与河对岸的空档，只放在可走区之外，避开 city / skyline 的地块与网格包围盒）。每块一个槽位 `{ id, kind, cluster, center:[x,y,z]（世界坐标，楼层面）, yaw, footprint:[w,d], height }`，在 `worldBase.massing = { slots, stats, root, removeSlot(id), replaceSlot(id, object3d) }` 里；按群落合并成一个墙体网格（`MeshToonMaterial`，顶点色，自动带卡通分档与描边）加一个窗户网格（`MeshBasicMaterial`，亮窗预乘发光增益），总共约 +20 次绘制、约 3.3 万三角形，不投影、无物理。种子、数量、高度、配色（傍晚／下午）都在 `massing.json`。`?massing=off` 什么都不装，画面与上一轮逐像素相同。

## 立面模块替换占位（第24轮）

`src/facade-blocks.js` 把汐的 `assets/blocks-2026-11-20/street-facade-01..04.glb`（宽 16 / 20 / 16 / 24 m，进深 10 m，+Z 朝街）按槽位铺进主街两侧与河对岸。开 `blocks` 时 `massing.json` 的 `blocks` 节会把 facade 地块改成「宽度 = 模块宽度之和、进深 10 m、群落 yaw = 朝向」的整排（`applyBlocksParams`），每排用种子随机组合模块（相邻不重复，随机镜像），再调用 `massing.removeSlots()` 去掉对应占位。每个群落合并成三个网格：纯色（墙、裙楼、壁柱、檐口、赤陶楼梯间、地基）、图集（窗、卷帘门、雨棚、空调；傍晚亮窗走 emissive 贴图，只取图集里亮窗格的玻璃）、招牌（运行时画的小图集，日文店名，无品牌名）。材质均为 `MeshToonMaterial` / `MeshBasicMaterial`，名字带 `massing`，所以天然带卡通分档与描边、不被做旧；招牌材质会被 `markSignMaterials` 标上描边。模块按自己脚下地形最高点落地，往下用地基裙边伸到最低点，不会悬空。`?blocks=off` 保留第23轮占位（逐像素同 r23c），`?massing=off` 仍什么都不装。静态服务器新增 `/blocks/` 路由指向该素材目录（`scripts/baseline.cjs`）。

## 中层过渡带 + 地标塔 + 大广告牌（第26轮）

远景塔（约 80 m）和街边立面（约 13 m）之间尺度跳得太大，这一轮在中间加一层。素材是汐在 #274（修订后：窗带 3.2 m 一层、广告牌立柱已修、地标顶冠 0.62）给的四个 GLB：`skyline-tower-midrise-{tank,billboard}.glb`（50 × 20 × 23 m，屋顶广告牌 9 × 5.5 m）和 `skyline-tower-landmark-{tank,billboard}.glb`（20 × 20 × 102 m，顶上井筒到 110 m）。规则全在 `src/midband-blocks.js`，几何仍由 `tower-blocks.js` 同一条管线出：同一张塔图集（傍晚恰好 17 % 窗格亮）、同一张招牌图集、同样的卡通分档与描边、同一套逐像素距离雾，所以雾色、亮窗比例、招牌和塔完全一致。

- **中层带**：`layoutMidband()` 在 `massing.json` 的 `blocks.midband` 参数下自动找空地，不为任何镜头手摆。候选点按种子撒在车站周围，要求离可走区（`station.bounds`）35–150 m，通过 `massing.rejectReason()`（可走矩形、走廊、city / skyline 地块、已有网格、村落、道具，和 facade / tower 群落同一套排除，本轮从 massing.js 开放出来，不改它自己的放置结果），离所有槽位和已选地块 ≥ 6 m，地面在水线上且起伏 ≤ 2.6 m，朝向取最近的街道方向吸附到 90° 网格；按 8 个扇区轮流补，使它围着街而不是扎堆。每块 44–56 × 18–22 m、21–25 m 高，40 % 带屋顶广告牌。结果作为额外槽位交给 `createTowerBlocks({ extraSlots })`，排在塔槽位后面，所以塔槽位的索引和随机种子不变。
- **地标**：`pickLandmarks()` 从塔槽位里选「从主街各点（z 10–100）看过去，落在街向 ±14°、距离 380–700 m、占地 ≥ 17 m」里得分最高的 2 个（互相 ≥ 120 m），换成 landmark GLB（不缩放、不拉伸）。
- **广告牌**：新 GLB 自带 9 × 5.5 m 屋顶板；旧的六个塔变体的屋顶板在开中层带时放大到 8–10 × 5–6 m（立柱跟着移到板下）。板面用招牌图集里新增的 512 × 320「方形广告」格（`blocks.midband.signs.b`，两行大字日文；原有 1024 × 128 的宽幅格裁成 9:5.5 会把字切掉）。招牌图集只在开中层带时才加高到 4096，关掉时是 r25 原样。
- **开关**：`?midband=off` 不布局、不装 GLB、不放大广告牌、不加图集格，场景与 r25 代码等价：在同一套 #274 修订后的塔 GLB 上，r25 源码和 `?midband=off` 的所有 `massing*` 网格几何哈希相同（`25ca9a16`），主街傍晚绘制调用 1038 次、三角形 5,478,308 完全一致。像素不做逐点比对——前景动画按实时时钟走，同一份代码连拍两次也会差几万像素。注意 r25 对照图必须在 #274 修订之后用 `?midband=off` 出，因为 6 个老塔 GLB 的窗带也重导过。证据见截图目录 `r26/evidence.txt`。`?towers=off` 会连带关掉整条塔管线，中层带和地标也就不装。四个新 GLB（midrise / landmark）缺失时，只在控制台警告并跳过中层带和地标，页面照常、老塔和 `?midband=off` 不受影响。
- **已知**：主街机位的变化主要在车站屋顶后面（淡淡一层宽块，下午更清楚）和地标塔变高；傍晚主街 1038 → 1041 次绘制、5.478 M → 5.491 M 三角形（新 GLB 比旧塔轻）。四个固定机位里只有「主街」看得到中层带（它们都是近景，背景被建筑和樱花挡住），B / C / D 与 r25 几乎一样（差异在噪点级）。中层带在 200 m 以上，雾量约 43 %，所以是淡淡的一层宽块，不是清晰轮廓。

### r26b：中层带前移、加高、减雾，地标进主街视野

汐在 3060 上实测 r26 太淡（主街机位只在天空带有变化，铁路机位 0.012 %）：中层带离可走区 35–150 m，正好落在距离雾最浓的 50–150 m，高度又只有 23 m。r26b 只调规则和参数，不换素材，`?midband=off` 仍与 r25 几何一致（不布局、不装这些 GLB、`massing*` 网格不变；新增的雾增益参数在关掉时不参与任何材质）。参数都在 `massing.json` 的 `blocks.midband`：

- **往前挪（紧贴立面背后）**：`layoutMidband()` 不再在车站四周撒点，而是按种子顺序、各立面群落轮流，逐个立面排（`facade` 槽位）取它**背面**放中层楼（每排最多 `perSlot` = 2 栋）：同 yaw（所以和立面一样朝街）、与立面背面留 `backGap` = 2–4 m 空隙（种子随机）、沿立面方向随机侧移最多 `slide`（0.6）×两者半宽之和，让相邻楼错开铺开。立面排在同一群落里前后错落，背后有别的排挡着时，楼往后退（每步 0.5 m，最多 `pushMax` 40 m）直到离所有立面都有 `backGap` 的空气。要求：离可走区**最近边** `band` = 20–100 m（见下「已知取舍」）；与每个立面槽位 / 塔槽位做**有向包围盒精确相交**（立面排有 ±0.3 rad 的偏转，用轴对齐盒会误判），塔留 `gap` = 6 m、中层楼之间留 `lotGap` = 4 m；其余沿用 `massing.rejectReason()`（可走矩形 + `boundsMargin` 6 m、走廊、city / skyline 地块 `lotMargin` 6 m、已有网格、村落、道具）与地形（水线以上、起伏 ≤ `maxRelief` 2.6 m）。`footprint` [50, 20] 是 GLB 的真实尺寸（横向不再缩放），`clear` [54.4, 21] 是检测用的盒（含楼梯间核心筒 3.2 m），`frontPad` 是裙楼凸出的 0.4 m。`count` 是上限（24），实际数量取决于有多少立面排背后放得下；`tries` 是对立面槽位的轮数。
- **加高**：中层 GLB 纵向缩放到 `height` = 28–32 m（半米一档，种子随机；原 23 m，Y 比例 1.22–1.39，不受塔管线通常的 ±25 % 夹紧；屋顶设备和广告牌不跟着拉伸）。窗带因此每层约 4.2–4.4 m。
- **雾减轻**：`fogGain` = 0.55，中层带的墙 / 窗图集 / 招牌用自己的三份材质，把 `patchAerial` 算出的雾量再乘 0.55（颜色混合与亮窗、招牌的淡出一起变）；亮窗比例仍是塔图集的 17 %；其他塔、立面的材质和着色器代码不变（`patchAerial(…, gain = 1)` 默认值与 r25 逐字相同）。
- **地标必须在主街视角里**：`landmarks.views` 里写了 `art-a-street` 和 `sample-g-rail` 两个机位（位置 / 朝向 / 垂直 fov 与 `main.js` 里的 `worldBase.views` 一致）。`pickLandmarks()` 对每个机位，在塔槽位里找水平距离 `dist` = 150–400 m、离视线方向 ≤ `halfAngle` = 25°、占地最小边 ≥ 17 m 的，用几何估计「地标从底到 `top` = 110 m 有多少度没被前面的东西挡住并落在垂直视野内」：沿机位到地标宽度方向 5 条射线，遮挡物 = 全部立面排、中层楼、其他塔的有向包围盒及其顶高，取最大仰角；得分最高者（不够 2° 就不选）换成地标 GLB，每个机位 1 栋，两栋至少相距 `minGap` 120 m。不渲染、不截图。没有计入的遮挡：车站内 city / skyline 建筑、樱花树。
- **实测（云端无头，未渲染）**：放了 6 栋（flank-e 2、farbank-w 2、flank-w 1、farbank-e 1），最近边离可走区 61.8–98.8 m、中心 72–110 m，高 29–32 m，与立面背面空隙 2.0–3.9 m，雾增益 0.55；地标 `tower-north-00`（art-a-street：368 m、偏 3.6°、可见约 15°）和 `tower-west-05`（sample-g-rail：296 m、偏 6.5°、可见约 20°）。默认参数加载 `worldBase.ready` 为真、`errors` 为空、控制台无 error。
- **已知取舍**：①立面排本身离可走区就有 8–86 m（侧翼 x ±100–178，北岸 z −128…−215，边界在 x ±92、z −97…128），所以背后的楼最近边多半在 60–100 m，`band` 上限从目标的 80 m 放宽到 100 m，否则北岸一排全部落选。②实际只放得下 6 栋（上限 24）：立面排前后错落、南面是水（地面检测）、走廊和村落把其余槽位背后的地方占了；想要更多，下一步是允许放第二排（立面背后 + 一栋楼的深度）或放宽 `maxRelief`，这需要汐看了图再定。③每个地标的遮挡估计只算立面、中层楼、其他塔，不含车站内的 city / skyline 建筑和樱花树。④中层楼纵向拉到 28–32 m（×1.22–1.39）后，窗带每层约 4.2–4.4 m，比塔上 3.2 m 一层的窗高，近看是否别扭请汐看图。

### r26c：换 midrise30 GLB，放宽限制到 12 栋

中层带改用 #278 的 `skyline-tower-midrise30-{tank,billboard}.glb`（50 × 20 × 30 m，窗带 3.33 m 一层），高度 30–32 m，纵向系数约 1.0–1.07（r26b 是 1.22–1.39）。放宽 `blocks.midband`：`band` 上限 100 → 150 m、`maxRelief` 2.6 → 5 m、`minGround` 1.5 → 1 m、`pushMax` 40 → 80 m；仍用有向包围盒检查，不放第二排，`?midband=off` 不变。云端无头加载（未渲染）：12 栋（r26b 为 6），主街机位视野 ±30° 内 4 栋，最近边离可走区 45.8–125.4 m，`worldBase.ready` 为真、`errors` 为空、控制台无 error。

### r26d：主街左侧加 focus 扇区 + 修 `?midband=off` 泄漏

- **泄漏原因**：r26c 的 `massing.json` 里把 `blocks.midband` 的 `minGround 1.5 → 1` 用批量替换时，顶层 `facade.minGround` 也被改成了 1（汐实测港镇机位 0.102 % 像素差的来源）。立面排的放置检查变松，off 时也多放/挪了立面。已改回 1.5。证明：`?midband=off` 下遍历场景全部 Mesh，对顶点位置抽样 + 世界矩阵做哈希，并对 `massing.slots`（中心、朝向、尺寸、高度）做哈希，和 `git worktree` 检出的 r26b（bcb7cf0）逐项比对（`massing.slots` 哈希在 off 下与 r26b 完全一致（1555767746）；全场景 Mesh 哈希因含随时间变动的矩阵，未能证明逐位一致，见汇报）。
- **focus 扇区（通用规则）**：`blocks.midband.focus = [{ view, yawRange, pull, want, extra, dist, corridor }]`。`view` 指 `landmarks.views` 里的机位名，`yawRange` 是相对视线方向的方位角（负 = 左），只有落在扇区里的中层楼被放宽：①最多往可走区方向挪 `pull` m（逐米试，取最大的合法步长，仍须不与立面/塔/城区/可走区相交、离立面背面 ≥ `backGap[0]` = 2 m）；②扇区里不足 `want` 栋时再补最多 `extra` 栋（方位每 2° × 距离每 6 m 的极坐标搜索，朝向取最近立面排，优先选离已有楼最远的位置）；③`corridor:false` 时只在这个扇区忽略走廊。别的方向规则不变。当前参数：`art-a-street`，方位 −45°…−10°，`pull` 15 m，`want` 6，`extra` 2，距离 90–260 m。

### r26e：中层楼离可走区一律 ≥ 45 m，focus 关掉

- 所有中层楼按旋转后外接矩形（AABB）算，离可走区至少 `blocks.midband.minAabb` = 45 m（r26d 的 `midrise-11` 离边界 23.9 m，现在不会再出现）。
- `blocks.midband.focus` 条目加了 `enabled:false`，r26d 的 pull / 补楼和 r26e 试做的 slab / setback 扇区高楼代码保留（`shape`、`fallback`、`stretch`、`minNear`、`step`、`shapes`），但默认全关，不再为单个机位调。
- pull 挪不动的原因（r26d 拒绝统计）：逐米尝试共被拒 57 次，全是 `slots`——中层楼本来贴在立面排正后方（留 2–4 m 空气），往前一步就压进前面那排立面，只能挪 0–2 m。
- `?midband=off` 不受影响。

## 立面距离雾 + 真高楼替换占位塔（第25轮）

`src/block-common.js` 放立面与高楼共用的东西：种子工具、合并几何 `Bucket`、招牌 canvas 图集（新增宽幅广告牌格）、以及**按相机距离的空气透视补丁** `patchAerial`。雾量用 `massing.json` 傍晚/下午 `fog` 的同一条近/远曲线（近 190 m → 0.42、远 850 m → 0.78，线性），乘一条 `blocks.fog.start`（50→150 m 的 smoothstep）让 ~60 m 以内保持清晰；雾色是着色器里直接调上游 `skyBase`，方向取「像素水平方向 + 模块顶冠（`skyAt` × 高度）的仰角」，再按 `lumaMax` 封顶、`desat` 去饱和、`gain` 缩放，和 massing.js 给占位塔烘的雾色同一公式，只是改成逐像素、跟着真实相机走。亮窗 emissive 与招牌按 `1 − litFade × 雾` 淡出（招牌再乘 `windows`）。雾在光照之后混合（与 massing 的 `addFog` 同位置），描边由屏幕空间后处理按场景色算，所以随雾一起淡，远处不会冒黑线。

`src/tower-blocks.js` 把汐的 6 个塔 GLB（slim / slab / setback × tank / billboard）按槽位替换占位塔：每槽位按占地和高度挑最贴的变体（XZ 等比 ±15 %、Y ±25 %，屋顶设备不随 Y 拉伸），绕 90° 步进转向群落 `face`，随机镜像，同一邻域内尽量不用相同体型，再检查不与其他槽位重叠。原占位上带屋顶招牌的槽位用 billboard 变体，两面广告牌贴宽幅招牌。窗带用 512² 塔图集：傍晚把图集整张重画（恰好 17 % 的窗格亮，冷暖混合，另出一张只含亮窗的 emissive 贴图），每条窗带随机取一行和整格 u 偏移；下午用 GLB 自带白天格。每个群落合并为实心 / 图集 / 招牌三个网格。`?towers=off` 保留 r24 的占位塔；`?blocks=off` 与 `?towers=off` 互相独立，两个都关等于 r23c。

## 湿路店铺倒影（第22轮）

湿路原来只采样一张离线烘好、整条街共用一个 box 的 256² 立方体（`street-env*/`），权重又很低（0.03～0.23），所以只剩一层天空色。`src/street-zones.js` 把主街沿 z 切成 5 个区（`toon.json` 的 `evening.refl.zones`，局部 z 3～36 m），每区一个 AABB（街宽 × 到屋檐 × 区长再各加 `pad`）和一张 512² HalfFloat 立方体，加载末尾在每区中心、离地 1.5 m 处烘一次（不落盘、不进仓库）。烘焙时隐藏岛屿（除天空）、车辆、自行车、列车、电线、路口光晕、店前光斑和橱窗玻璃，做完全部还原。路面着色器按自己的 z 选区（区界 `blend` m 线性过渡），把反射向量对该区 box 做视差校正再采样；招牌／橱窗灯沿仰角往下多取 `streakTaps` 个点、只累加 `streakThresh` 以上的亮部，拉成竖条。

`?refl=old`（或 `?toon=off`，或下午预设 `refl.on:0`）不装着色器分支、不烘焙，和第21轮逐像素一致。运行时调参用 `worldBase.refl.set({ lod, lodRough, lodPuddle, base, grazing, dry, ripple, streakLen, streakThresh, streakGain, streakLod, streakTaps, on })`（任意子集，非有限数或未知键会抛错且不写入，`streakTaps` 钳到 0～8，返回当前值）和 `worldBase.refl.get()`。`lod` 给数字同时设两档，给 `[粗糙, 水洼]` 分别设；`lodFar` 是 `lodRough` 的别名。不要直接 `worldBase.refl.uniforms.uReflLod = 1`（着色器仍持有旧对象，什么都不变），也不要把数字写进 Vector2／Vector4 uniform 的 `.value`（`uniform2fv(1)` 每帧抛错，画布停在上一帧）。烘焙耗时 `worldBase.refl.bakeMs` 用 `Date.now()` 计，捕获脚本把 `performance.now()` 钉死时也有值。

## 街道道具与植被（2026-11-21）

全岛通用的自动铺放，不为任何机位手摆。两个模块各自一个开关，关掉时**完全不加载**（`main.js` 用动态 `import`，文件都不会请求），画面等同没有它们：

| 开关 | 模块 | 内容 |
|---|---|---|
| `?props=off` | `src/street-props.js` | 电柱、电线、标志牌、贩卖机、邮筒、消火栓、护栏 |
| `?veg=off` | `src/vegetation-scatter.js` | 阔叶/针叶/樱/行道小树、灌木、绿篱、草簇与小花 |

共用 `src/scatter-common.js`（GLB 读取与合并、卡通材质 + 距离雾、实例批次、场景事实查询）。

**模型与权重全在资产表 `src/props-veg.json`**：GLB 路径、期望尺寸 `size`、原点偏移 `origin`、`scale`/`fit`、`snapGround`、放置半径 `radius`、每组/每树种的权重和缩放范围。代码只按「组」或「树种」取模型，不出现文件名。换模型或整包重做只改这个表；GLB 实际包围盒与 `size` 相差超过 35% 会记入 `worldBase.scatter.*.summary.sizeWarnings`。电线不是 GLB：每个电柱条目的 `attach`（挂线高度 + 横向偏移列表，列表长度即每跨根数）和 `wire`（下垂比例、线径、段数、颜色）程序生成，一个跨合并成一个网格。静态服务器路由 `/street-props/`、`/vegetation/` 指向 `assets/props-2026-11-21/`、`assets/vegetation-2026-11-21/`（`scripts/baseline.cjs`）。

### v2 模型（X-51，2026-11-21）

三套 v2 模型（汐出品，报告 json 在各自文件夹）接进同一张资产表，静态服务器多了 `/trees-v2/`、`/grass-v2/`、`/poles-v2/` 三个路由；模型条目可写自己的 `base` 覆盖段落的 `base`。`scatter-common.js` 的读取器现在认两类部分：无贴图的材质色（`vertexColors: true` 时再乘 GLB 自带顶点色）合成一个几何；带基色贴图的 alpha 卡片（叶卡、草卡、花卡）单独成一个几何并保留 UV，用 `alphaTest 0.5` 的卡片材质画，不做混合，所以没有排序问题。一个模型最多两个 InstancedMesh（实体 + 卡片）。

- **阔叶树远近 LOD**：`vegetation.lod`（`nearDist` 60 m、`hysteresis` 8 m、`cell` 64 m、`step` 3 m、`nearMax` 100）。轻量模型的条目写 `near: "<v2 模型 id>"`。全部阔叶树仍在远处的轻量 InstancedMesh 里，按 64 m 方格排序；`worldBase.vegetation.update(camera)`（`main.js` 每帧调一次，`?veg=off` 时不存在）先用相机到方格包围盒的距离筛掉远格，相机移动不足 `step` 就什么都不做；近处的树在远 mesh 里置零矩阵、写进 v2 的近 mesh（最近的 `nearMax` 棵）。每棵树 `< nearDist` 变近、`> nearDist + hysteresis` 才变回远，不抖动。不用每树一个 THREE.LOD。
- **树冠调色**：`vegetation.tints`（`treeLeaf`、`grass`、`flower`），模型用名字引用。着色器里 `rgb = mix(灰, rgb, sat) × mix(low, high, smoothstep(from, to, 高度/模型高))`，只作用于偏绿的像素（`leafOnly`），树皮另用 `bark: { mul, sat }`。当前 `treeLeaf`：下冠偏蓝绿（1.32, 1.46, 1.40）、树顶偏黄绿（1.85, 1.80, 1.12）、饱和度 0.6。运行时可改 `worldBase.scatter.veg.materials.all()` 里各材质 `userData.tintUniforms`（`uVegLow` / `uVegHigh` / `uVegRange` / `uVegBark`）实时看效果，定下后写回 json。
- **草与花**：`veg-grass-tuft` 换成 grass-clump-a/b + flower-yellow/white/pink（`flower` 树种：黄 0.42、白 0.42、粉 0.16）。分区：树脚和灌木脚；站区与 Cairnwick 周围的开阔草地（密度 ×`meadowBoost` 1.7，花斑用 14 m 噪声成片，花占比 0.3～1.9 倍 `flowerShare` 0.27）；这两处焦点附近每条路两侧 0.4～2.6 m 的路肩（`grass.edge`：每 1.7 m 一次、花占 40 %，更密）。总上限 `grass.cap` 22000。
- **电柱**：poleA / poleB 换成 pole-utility-a / b（11 m / 12 m）。`attach.height` 取顶层横担绝缘子顶（A 10.75 m、B 11.8 m），`offsets` 取三个绝缘子的横向位置（A ±0.88、B ±0.96）；一跨两端电柱型号不同时，横向偏移沿跨度线性过渡。wire-bundle.glb 不用，电线仍程序生成。
- **电线避楼**：每一跨的每根线（每 ~1.5 m 采样）若落进任何 `bld` 地块盒（城市/天际线/立面/塔/中层楼和 massing 排除盒），或低于聚落实体高度图（房屋、墙、树）的顶，整跨不画，计入 `summary.wireBlocked`。
- **关闭开关自检**：`?props=off&veg=off`（加 `refl=old` 跳过3分钟反射烘焙、钉死 `performance.now`/rAF 时间戳/`Math.random`，无头 Chrome + SwiftShader）下，8 个机位（art-a/b/c/d、sample-e/f/g/h）的 PNG 与改动前的提交 `c6f1f2d` 逐字节相同。单独只关一个开关没有逐像素对比（另一个开着时画面当然不同）。
- **顺带修的旧问题**：`street-props.js` 原先把电柱朝向写到了记录副本（`p.rec.matrix`）而不是实例条目，电柱实例矩阵是 NaN，电柱本体一直没画出来（电线是正常的）；现在写到 `p.rec.item.matrix`。

### 数据来源与避让

- 路网：车站 `layout.js` 的 R1–R6（仅用于距离判断，站内上游已有电柱/贩卖机/标志/护栏，只补上游没有的邮筒、消火栓，放在主街地块接缝，避开门洞和上游贩卖点），加 Petalwake 三个聚落的 `assets/town/sites.json` 街道（中心线 + 宽度）和地块多边形。
- 避让：站内可走矩形与店铺附加可走区、城市/天际线/立面行/塔楼/中层楼的包围盒、massing 的道路走廊、`ctx.physics` 实体碰撞盒、聚落的 `Town.heightAt` 实体高度图（房屋、墙、树、船）、岛上旧树和岩石、河带、水下、坡度、草地覆盖（splat 的 A 通道，各处 `clearVegetationAreas` 之后读取，镇、地块、站区都已清零）。
- 规则参数在各文件顶部的 `PARAMS`：电柱间距 25–35 m、路缘外 1.1 m；路口标志（支路 stop，其余按权重）；地块两端接缝放贩卖机/邮筒/消火栓；落差 > 1.1 m 的路边铺 2 m 护栏段；树的疏密由 230 m 尺度噪声成片、按到车站/两个镇的距离衰减，树线以上与陡坡不放；绿篱沿可走矩形外 1.4 m；草簇铺在树脚与站区、Cairnwick 周围的空地。`cap` 控制上限（总预算：新增 draw call ≤ 60，三角面 ≤ 1.5 M）。

自检结果和实例数见本分支提交说明；运行后 `worldBase.scatter.props` / `.veg` 里有各类计数、`drawCalls`、`triangles`、被拒原因统计。

## 当前状态

第17轮源码`0184c79`的[3060地表与参数归属回验](./evidence/greenery-c17-2026-11-18/README.md)关闭C16交回的两项缺陷：两原机位的北侧亮绿细带消失，terrain／transition／两份站区edge blend实际共享TOWN参数；双look、未注册Meadow、质量重建和材质池重新归属的15条CPU断言全部通过。四组恢复后的PNG都与各自开启时完全相同。仍是定向回归关闭，不是整体风格／P2验收。

镇边仍29,933三角。服务角／04／店前近景对C16整PNG相同，01有255像素最大9色值差，完整差异见证据。四机位与两走均约65FPS、p95均15.5ms；初始975帧有8帧>20ms、最长30.8ms。正常／定向actual exit均1，分别保留4／3次资源取消，0JS异常，14行为／look／walking通过，51定向图完成。源码关联Windows合并引用CI实际1615测试／9类型／2构建、20code0。下一棒交C酱收24／21近景绿篱的重复斑块感，保留叶团体积和既有草花主次；保持Draft、不合并。

### 历史：第16轮草花配色

第16轮源码`50e190b`的[3060草花配色回验](./evidence/greenery-c16-2026-11-18/README.md)确认主次改善，但发现两项待修：北侧terrain已变色、transition与站区edge blend未继承，实图出现亮绿细带；同JS环境第二个look的meadow继续引用第一个look参数。前者由两机位开／关／恢复及实际GL shader共同定位，后者有实际CPU复现，不是当前首次启动故障。交C酱修这两项，未通过整体美术／P2验收。

本轮镇边仍29,933三角，04与店前近景对C15整PNG相同，01仅5像素最大2色值差。四机位64.039–65.000FPS、两走约65，但初始921帧有62帧>20ms、p9530.7ms、最长46ms；未归因或重跑挑绿。正常／定向actual exit均1，分别保留1／2次资源取消，0JS异常，14行为／look／walking通过，51定向图完成。Windows源head关联的合并引用CI实际1615／9类型／2构建，20code0；CI不覆盖上述视觉与生命周期问题。保持Draft、不合并。

### 历史：第15轮立面生活物

第15轮源码`96ddf39`的[3060立面与服务角实机记录](./evidence/facade-c15-2026-11-17/README.md)已完成：删516三角隐藏面、加896三角稀疏生活物／店招，镇边29,933，服务角单独+18至2,442。外机、雨管、洗衣店文字、棚百叶和贴纸实际可见；旧周转箱与楼梯外形保持。文字更新既有第5页图集空区像素，未新增纹理对象／页／容量。不是每户满配，整体美术与P2仍未验收。

四机位62.760–65.000FPS、两走约65，p95均15.5ms，最长31ms；14行为／look／walking通过。正常actual exit1保留boulders／menhir两取消，定向21图exit0、无网络／JS错误；04与店前近景对C14整PNG相同，01有83像素最大1色值差。6对重复PNG相同，01另有62像素最大1色值差。CPU中间dirty源、首次driver失败与实际帧样本均分开保留。Windows关联源head的合并引用CI实际1615／9类型／2构建、20code0。下一棒交C酱做镇边草花／绿篱配色密度及砾石尺度；保持Draft、不合并。

### 历史：第14轮墙面局部收敛

第14轮源码`7d362bc`的[真实素材／编译与性能复核](./evidence/look-c14-2026-11-17/README.md)完成。公寓墙独立低对比材质使20／21重复灰斑和24黑点明显退下，结构阴影清楚；这一局部问题关闭，整体风格／P2仍未验收。共享concrete、桶、台面和布局保持，镇边仍29,553三角。

首轮鸟瞰58.63FPS／p9530.8ms、184帧20个>20ms；针对该波动唯一同源复核为65.00FPS／p9515.5ms、202帧0个>20ms，未复现但原因未定，两轮原记录都保留。两次正常基线均14行为／look／walking通过，实际exit1分别保留2／3次资源取消；定向21图exit0、0网络／JS／HTTP错误，04／23对C13整PNG一致。真实GL编译和mix读取通过，0.93为固定目标而非纹理均值，结果既降对比也提亮。源码Windows1615／9类型／2构建／20code0；请C酱按#252做四区整体评审，继续Draft、不合并。

### 历史：第13轮材质收边

第13轮源码 `1677ea3` 的 [3060真实素材回验与局部反馈](./evidence/look-c13-2026-11-17/README.md) 已完成：两处桶身／暗盖配色改善，墙面旧圆弧消失，台面原外侧共面竖面移入压顶内，支撑和碰撞未变；镇边仍29,553三角。21／20的5F向阳墙仍有过重、重复的灰斑，下一棒交C酱只收公寓墙独立材质的纹理对比，保留共享concrete、桶、台面和全局光照。

本轮四机位约64.36–65.00 FPS、两种步行约65，六段p95均15.5ms，14行为／look／walking通过；正常／定向均实际exit1，分别保留2／3次资源取消，无JS异常。初始4帧、鸟瞰2帧>20ms，最长30.9ms。定向21图默认AO；04对密度首版／C12整图PNG一致，01对密度首版524像素变化，不能全归为动画。源码Windows实际1615测试、9类型、2构建、20code0；P2及整体美术验收仍未完成，保持Draft、不合并。

### 历史：首版四区密度

第12轮后按C酱分工补四处生活道具：[实装、失败与回验](./evidence/density-2026-11-17/README.md)。`0d97731` 在洗衣店前加伞架／分类桶，楼后加清扫物／电表／两只图集纸箱，服务角加分类桶／簸箕，街道加E2墙面电表；均复用原MIT资源，无新增纹理。镇边实际29,553三角（+444），站区单独+132。原正常基线因分类桶实例缺单个footprint而快照失败，`6b0e9c4`在生产端将两桶分别登记，保留绘制及碰撞体后重新跑完整基线通过渲染链路；失败报告原样保留。

修补后四机位65.002／65.000／64.039／65.002 FPS，三／一人称64.997／65.000，p95均15.5ms；14／14行为、look、walking通过。初始5个与鸟瞰3个>20ms帧、最长30.9ms仍保留；最终正常与独立定向各实际退出1，均只记录crate.bin加载取消。21张定向图在0d97731采集，七对重复一致，04对C12全图RGB差0；不冒称它们采自修补头。伞架、桶和电表实际可见；楼上纸箱及服务角簸箕有遮挡。当前可交C酱做材质／构图统一，P2和整体验收未完成，继续Draft、不合并。

第12轮C酱在 `e38dd51` 改为有纹理的灰色台面与窄浅边、洗衣店青墙／灰地／更透明的玻璃，以及1.5m墙面UV周期。[3060真实素材回验](./evidence/look-c12-2026-11-17/README.md)确认21／24机位改动生效，04店内AO开关图分别对C11全图RGB差0。墙面仍可见圆状污纹；外侧9cm共面侧带在固定图未见花边，但未排除移镜风险，保留给下一棒局部收边。

本轮镇边29,109三角，四机位64.680／64.998／65.002／65.002 FPS，三／一人称64.039／64.361，p95均15.5ms；14／14行为、look、walking通过。初始和街道／走路仍有30.8ms长帧；正常运行与固定图均实际退出1并保留资源取消。源码Windows实际1615／1615、9类型、2构建通过。该轮交接要求补四处人眼区域的生活道具密度，守30,000三角和原通路；后续实装见上节，P2仍未完成。

第11轮C酱在 `e1f32af` 将AO近处衰减改为采样平面距离，并移除city末尾统一投影标志覆盖。[3060真实素材回验与GPU逐采样](./evidence/look-c11-2026-11-17/README.md)确认C10后墙次峰在固定ROI和六点中消失：y304／313／322的GPU AO为.915959／.962688／1。灯与玻璃现在不投影；主楼和背部钢梯投影仍清楚。另四个Toon分箱恢复原不投影标志，其中包含六组入口／连接台阶；两个人眼机位的临时恢复对照未见主结构明显回退，恢复后PNG字节相同，没有盲目重开所有分箱。

本轮四机位及三／一人称均约65 FPS，六段p95均15.5ms，14／14行为、look与真实走路通过；初始982帧和六段采样未见>20ms帧，只能描述本次采样。正常、固定机位及独立GPU采样均实际退出1，各保留两次加载取消，无JS异常。源码Windows实际日志1615／1615测试、9类型、2构建、20步全退出0。镇边仍28,857三角形；暗部HDR回归保持。当前关闭两项定向回归，下一棒按1.6m真实图审两处示范区的材质主次与密度；P2和整体美术验收仍未完成，保持Draft、不合并。

第10轮C酱在 `53cb20a` 调整AO权重并新增门灯、乳白洗衣店灯箱；[3060真实素材回验与逐采样读回](./evidence/look-c10-2026-11-17/README.md)记录新增38个灯盒、456三角形，镇边共28,857三角形。灯箱实拍略暖乳白，局部自亮面不等于新增实时光源。店内后墙仍有次峰：实际GPU AO在y304为0.939604、y313降到0.885748、y322又升至0.994971；逐采样确认主要来自同一顶棚的外圈采样，不能解释为第二块招牌的贴墙接触。新灯的shadow:false还被city末尾统一castShadow=true覆盖，实际仍投影；原CPU相反措辞已附勘误。这两处继续交C酱修，尚未通过整体验收。

本轮四机位65.0037／64.9998／64.6793／65.0019 FPS，三／一人称64.9977／64.9998，p95均15.5ms，14／14行为、look、真实走路通过。鸟瞰仍有1帧30.8ms；正常、固定图与独立逐采样诊断各实际退出1，各保留3次加载取消，无JS异常。C10源码Windows实际日志1615／1615测试、9类型、2构建全部退出0；另有CPU解析屏边断言失败，作为未获GPU实景证实的候选记录，不混称所有检查通过。P2未完成，保持Draft、不合并。

第9轮C酱在 `1b63536` 修复暗部contrast黑点并重写视空间AO；[3060真实素材回验](./evidence/look-c9-2026-11-17/README.md)确认卷帘暗纹恢复、店前和楼后的明显光环改善。固定旧机位两个HDR ROI与C8逐值相同，最终像素从[0,0,5]／[0,0,3]变为[26,31,42]／[26,31,41]。默认contrast仍1.05，没有改成无光材质。店内后墙仍有随AO关闭消失的浅横带，两次固定截图可复现，尚需C酱继续处理。

本轮四机位和三／一人称均约65 FPS，p95均15.5ms，14／14行为、look和真实走路通过；初始970帧中仍有12帧超过20ms，最长30.9ms。正常运行与独立诊断均实际退出1：每次各记录一次crate glTF加载取消，renderOk=true、transportClean=false，无JS异常。源码Windows实际日志1615／1615测试、9类型检查、2构建全部退出0。没有把渲染通过等同于运输或美术通过，也未证明旧帧时波动根因已修。P2仍未完成，保持Draft、不合并。

第8轮C酱增加城镇投影、4096阴影图和深度AO；林离回验并加入两处带纹理道具。[历史实拍、因果对照与全部失败记录](./evidence/textured-props-2026-11-17/README.md)分别保存原C8、道具初版和镜头修补后源码。AO的屏幕边缘成对采样当时已修，但店前、楼后的新增条带尚未消除；右墙原grime环纹与AO问题分开记录。

两处首轮布置为工具棚前原比例周转箱/横跨筐沿的纸箱、两扇原门的卷帘材质，以及洗衣店右平台周转箱/矮牌/小盆。镇边共28,401三角形，门和六组台阶保持。`src/textured-props.js`负责原资产加载和显式cutout适配；station拥有7张新纹理，city克隆几何/材质并借用4张crate纹理，释放顺序仍是city先、station后。

镜头修补源码`38087c7`在3060上四机位65.002／64.998／61.157／65.002 FPS，三／一人称64.679／64.997，14／14行为、look和walking通过，实际退出0。本轮鸟瞰p95=30.7ms，不能称无掉帧；首轮和独立诊断的加载取消均保留，末次无取消不代表根因已修。Windows该源码实际日志1615／1615测试、9类型检查、2构建均通过。

两条1.6m细节机位已完整纳入道具，仍未通过整体美术验收。C8卷帘UV／贴图／实际GPU受光正常，当时的固定HDR读回与contrast 1.05→1→1.05严格恢复证明后期负偏移把正的暗部细节压黑。该诊断促成C9在contrast层修复，没有把无光材质或全局contrast=1作为成品修补；剩余店内AO条带继续交C酱处理。

第7轮暖石地基、压顶和花海边缘已回验；[本机剖面、前后人眼原图和完整指标](./evidence/town-edge-2026-11-17/README.md)定位并修补了额外草衰减导致的裸地加宽。当时22,284三角形，修补后四机位和两段走路均约65 FPS，14／14行为通过；两版正常运行和独立诊断均实际退出0。历史加载取消和步行波动仍保留，未宣称根因全解决。

第6轮由C酱精修墙色、错位退界、清玻璃和低植栽，林离补齐专用玻璃释放及20处植栽清除范围。[前后本机实拍与完整检查](./evidence/town-polish-2026-11-17/README.md)记录整片镇边22,224三角形、无新增纹理；修补后四机位约65 FPS，第三人称65.002、第一人称64.680，14／14行为检查通过。洗衣机已可透过玻璃看清；草坪亮绿矩形边界和侧面地基仍待局部精修。资源取消仍使transportClean=false、总退出1；P2未完成，旧步行波动根因也未解决。

第5轮根据[C酱本机图评审](https://github.com/aa15119557034/agent-review-room/pull/254#issuecomment-6935791702)停止美式砖楼调整，改用站区套件日式公寓。[替换初版证据](./evidence/town-kit-2026-11-17/README.md)保留14,950三角形、四机位约63.7–65 FPS和第三人称64.356的历史数据，不代表第6轮当前几何与表现。

前一版三栋中层、井盖修正、资产清理与五轮交替步行对照见 [第四轮回验](./evidence/city-polish-2026-11-17/README.md)：固定机位约65 FPS，末次第三人称57.633、第一人称65.000；这是旧版数据，不能当作替换后表现。步行帧时波动原因未明，湿面两机位严格恢复通过。资源取消复现与已知Chromium终结状态缺陷吻合，本机运行时未修复，仍保留transportClean=false。含塔楼的早期试装和失败记录见 [76a000d历史试装](./evidence/city-background-2026-11-17/README.md)。

第三轮湿面精修、正常运行GPU复测和严格干湿对照见 [9417b6e本机验收](./evidence/gpu-wet-9417b6e/README.md)。第二轮精修单独复测见 [a7fe1e7 GPU证据](./evidence/gpu-polish-a7fe1e7/README.md)；花箱、外机、公寓及湿面诊断的早期失败历史见 [街景补充与交接](./evidence/streetscape-2026-11-17/README.md)。之前的地表对照、录像及未通过的诊断限制见 [地表与浅水修正](./evidence/terrain-water-2026-11-17/README.md)；首轮录像、原版基线和性能修复历史见 [EVIDENCE.md](./EVIDENCE.md)，旧录像不代表当前场景参数。第三方许可和修改范围见 [THIRD-PARTY.md](./THIRD-PARTY.md)。
