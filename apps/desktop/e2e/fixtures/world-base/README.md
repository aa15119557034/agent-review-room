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

在本目录使用已有 Electron 运行，无需构建桌面应用：

```bat
node scripts\baseline.cjs --scene=combined --electron=D:\codex\2026-11-16\world-implementation\runtime-path-probe\electron.exe --preview
```

去掉 `--preview` 自动采集性能、四机位截图和视频；录视频须同时指定 `--ffmpeg=<已有可执行文件>`，不会安装软件。`--output=<目录>` 指定保存处，`--stills` 跳过录像；`--video-only --video-ms=12000` 只重录四机位，不重做性能采样。录像仅采集 fixture 的 WebContents，将 CDP 画面按真实时间戳交给 FFmpeg 编码，不录桌面、不补帧或加速。原项目基线分别用 `--scene=petalwake` 和 `--scene=sakuragaoka`，默认不录视频；两者保留原 HTML、源码、默认质量和版本。原项目的 Google Fonts/CDN 默认经本机代理 7897，`--proxy=<地址>` 可修改。原项目首次加载统计包含这些网络请求，不等于纯本地场景构建时间。

## 组合场景

同一 WebGL2 renderer 和 scene 中保留 Petalwake 地形、港镇、河流、海面、云、植被，将车站放到 `(280,8,900)`，港镇在西南侧。站区核心保留原商店内景和步行碰撞，外围远景裁出，避免覆盖原岛。第一/第三人称用 V 切换，固定机位用 1–4，H 隐藏面板。

港镇色阶沿用车站明暗阈值；地形及填缝带则对已包含草地柔光校正的漫反射分成四档，避免把原始法线直接套入偏亮档位。描边与偏紫阴影使用车站规则；深度来自真实位移地形的颜色 pass，避免覆写材质后描出错误的地形网格。C酱精修后，低机位统一着色使用按最亮通道计算的软曲线，相机海拔 120–600m 逐渐切回 ACES；高空或关闭统一着色时使用 ACES。低机位还按深度加入远景空气透视。默认关闭运动模糊与 god rays，可单独开启对比；取消统一着色会恢复岛屿原漫反射计算，但保留公共调色、半球光和局部地表/水面适配，不能作为旧提交的严格对照或完全无后处理模式。

`src/main.js` 定义固定机位；`src/look.js` 是后续着色精修入口。`src/island.js`、`src/station.js` 和 `src/station-view.js` 分别负责岛屿、站区及步行镜头。未接入任何生产页面、规则、存档或契约。

## 当前状态

第一段、C酱首轮精修及本轮地表/浅水修正已落地。最新对照、RTX 3060 四机位、步行、当前录像及未通过的诊断限制见 [地表与浅水修正](./evidence/terrain-water-2026-11-17/README.md)。上一轮数据见 [精修后复测](./evidence/gpu-polish-294e85d/README.md)；首轮录像、原版基线和性能修复历史见 [EVIDENCE.md](./EVIDENCE.md)，旧录像不代表当前场景参数。第三方许可和修改范围见 [THIRD-PARTY.md](./THIRD-PARTY.md)。
