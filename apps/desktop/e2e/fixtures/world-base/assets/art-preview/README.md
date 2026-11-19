# C酱地面美术工作副本

美术分支是 `codex/X-51-ground-art-sync`。起点包含 0.50 远山、最终广场樱花、W3 树冠和三栋 Blender 楼体。C酱直接在本地看效果、修改并推送。林离在一批改动标记可验收时，用同一组相机做独立 RTX 3060 复拍与帧时检查。[本轮对照](https://github.com/aa15119557034/agent-review-room/pull/254#issuecomment-6995335505)

## 第一次下载与预览

以下命令下载当前分支的场景源码、运行包和可编辑素材，历史验收图可从 PR 查看。使用环境中已有的 Git、Node、curl、Python 3、NumPy、SciPy、Numba 和 Pillow。Linux 读取 ZIP 使用 unzip，Windows 使用系统 tar。

```sh
git clone --single-branch --branch codex/X-51-ground-art-sync --filter=blob:none --no-checkout https://github.com/aa15119557034/agent-review-room.git ground-art
cd ground-art
git sparse-checkout set --no-cone '/apps/desktop/e2e/fixtures/world-base/**' '!/apps/desktop/e2e/fixtures/world-base/evidence/**'
git checkout
cd apps/desktop/e2e/fixtures/world-base
node scripts/art-preview.cjs prepare
node scripts/art-preview.cjs serve 4173
```

准备脚本从项目各自的 GitHub 来源下载固定上游，校验 760 个原文件，从当前检出还原 18 项真实道具及公寓材质、4 个 GLB，并按这版太阳方向烘焙傍晚光照。访问输出的本地地址，从画面面板选择 A 主街、B 便利店正面、C 公寓后巷、D 洗衣店或 E–H 地面视角。已有浏览器或原来使用的 SwiftShader 都可以连接这个地址。

后续编辑 JS、颜色或材质参数后刷新即可。需要重新核对本机贴图时运行 `node scripts/art-preview.cjs verify`。更换发行素材或太阳方向后重新运行 `prepare`。已有 Python 位于独立环境时，可用 `WORLD_PREVIEW_PYTHON` 指定解释器。

## 修改和同步

开始一批工作前在美术分支执行 `git pull --ff-only`。本地可连续修改和预览。一批准备好后提交、推送，在 #254 留下提交号和要验收的机位。性能试验由林离放在单独分支。

```sh
git status --short
git push origin HEAD:codex/X-51-ground-art-sync
```

当前发行 ZIP 提供场景加载的四个 GLB。可编辑 ZIP 含五个 Blender 源文件、导出脚本和重建说明，包括站前樱花和东侧楼体。模型改动请同步可编辑源、运行包和发行校验值。[可编辑源包](../station-art/station-art-authoring.zip) · [运行包](../station-art/station-art-fixture.zip)

## 实际素材

白灰墙来自 Rob Tuytel，外墙砖来自 Charlotte Baglioni，卷帘来自 Dimitrios Savva，塑料筐来自 Fabi_G。15 个原始文件供应 18 项运行依赖，两份清单共享卷帘的三张贴图。对每一项核对字节数、MD5 和 SHA-256。[公寓材质清单](../../apartment-assets.json) · [道具清单](../../prop-assets.json) · [Poly Haven 素材许可](https://polyhaven.com/license)
