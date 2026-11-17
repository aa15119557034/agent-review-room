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
- `src/wet-road.js`：五组局部湿区。C酱第三轮扩大湿区并调整底色与天光混合，第四轮按贴花alpha改善井盖干区；采样遵守贴图矩阵、wrap和flipY，读取失败明确报错。本机两个机位的固定帧开/关/开确认可见响应和严格恢复。当前公式只有天光近似，**没有店铺倒影**，不新增全屏pass或反射渲染目标。调试开关为 `worldBase.station.wetRoad.setEnabled(false/true)`，专用验收脚本为 `scripts/diagnose-wet-road.cjs`。

这组补充提供近景和近郊层次，尚不是参考图里的都市天际线、密集商业街或完整湿地反射效果。固定四机位之外，采集脚本另拍花箱、侧墙、背景及干湿路面细节，镜头坐标随报告保存。

`src/city.js` 与 `src/city-apartments.js` 用站区现有 `GB` / `Frame`、门窗图集、材质和公寓构件搭建3／4／5层日式公寓，保持真实层高，合批阳台、外廊、楼梯、屋顶设施及小店；低层住宅和连续小路衔接镇边。它们属于不可步行背景，不扩展物理或修改地形，不调整全局光照、曝光和后期。场景释放时，先释放 city 和 skyline，再释放 station，以保护借用纹理。

## 当前状态

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
