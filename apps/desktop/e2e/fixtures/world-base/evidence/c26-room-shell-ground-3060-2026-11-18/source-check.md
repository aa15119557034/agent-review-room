# C26 源码与暖帘复核

核对提交 `a281e7a8acb8557a6d8fe399a7c57eff195f5879`。从 Git 对象导出准备脚本、清单和站区源码，在独立目录实测 `node scripts/prepare.cjs`，退出码为 0。八个店铺生成器在准备前后的 SHA-256 逐个相同。

## 上游副本

下列路径相对 `apps/desktop/e2e/fixtures/world-base/`。组合场景的 `src/station.js` 第 76–80 行从 `upstream/sakuragaoka/src/world/` 导入并执行站区模块。C26 在这份已入 Git 的源码中登记房间的内墙面、地板和天花板。原版基线使用的 `.local/<项目>-<commit>/` 则是从固定 ZIP 解出的原始项目。

本次用 `git archive a281e7a8:apps/desktop/e2e/fixtures/world-base` 导出 `sources.json`、`source-files.json`、`scripts/prepare.cjs`、`upstream/sakuragaoka/src/world`、`src/shadow-tint.js` 和 `src/station.js`。临时目录的 `.local/archives/` 初始仅有两个已缓存的 ZIP。准备脚本第 25–50 行检查归档 SHA-256、解压并逐件核验原件。若显式使用 `--vendor-code`，第 51–57 行会先检查目标目录，已有 vendored 目录时退出。

| 固定归档 | 上游 commit | 验过的原始文件数 |
| --- | --- | ---: |
| Petalwake | `25443cef0eba802052d9ef24c94ba3c4157b6f2e` | 599 |
| Sakuragaoka | `4112f57208b7e29998344ca71fef74202c2b2bdd` | 161 |

合计 760 个原始文件通过。对 `shopsA/{books,cafe,flower,konbini}.js` 和 `shopsB/{bike,general,ramen,wagashi}.js` 分别比较准备前、后的文件字节哈希，8/8 相同。这八个 Git 文件各有一条 `ctx.services.shopInteriors` 登记，固定上游原件仍保留原版。

## E2 与 E3 的室内暖帘

`shopsB/wagashiInt.js:46` 和 `shopsB/generalInt.js:128` 分别创建 E2 和 E3 的室内暖帘，杆位在各自店铺局部 z = −5.23 和 −7.33 m。`shopsB/common.js:527–529,586–602` 在站区更新时根据时间、阵风及玩家相对位置重写两片布的顶点和法线。相机朝向本身不参与计算。

用 vendored Three.js 几何和上述暖帘更新器做 CPU 检查，每扇帘取 54 个顶点，玩家远离门帘。站区时间从 10 s 切到 14 s，E2、E3 顶点单轴最大位移分别为 1.75 cm 和 3.54 cm。先让布帘经历不同时间及开合状态，再用相同玩家位置和 `dt=0,t=14` 更新，两次 14 s 顶点数组分别逐字节一致。

作者的 SwiftShader [采集脚本](../c-shadow-tint-r26/shot.cjs) 第 24、32 行暂停 RAF 后只把岛屿时间设为 10 s。站区暖帘可能保留各次加载的不同相位，单凭这组截图不能确定具体像素差的原因。本轮原生驱动对每个机位同时执行 `station.update(0,14,walker.worldPosition)` 和 `island.update(0,14)`。在玩家位置相同的条件下，驻留的旧暖帘相位可以排除；具体像素及阴影变化仍应从同版重拍和图像差分判定。
