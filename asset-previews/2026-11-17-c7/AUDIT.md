# X-51 实际素材审计（冻结）

2026-11-17。已完成允许范围内的 **13 文件、5,552,110 字节** 下载。全部与官方 files API 的大小和 MD5 相符，并逐文件计算 SHA256；再次离线重读校验也通过。保存路径为本目录 `downloads/`，未改 fixture，未运行 GPU，未转换图片/模型。

## 实际 glTF / BIN

| 项目 | plastic_crate_02 | painted_wooden_bench |
|---|---:|---:|
| 节点 / mesh / primitive / material | 各 1 | 各 1 |
| 三角面（实际 indices.count / 3） | 5,840 | 630 |
| POSITION 顶点 | 4,744 | 677 |
| 索引数 / 类型 | 17,520 / uint16 | 1,890 / uint16 |
| 节点变换 | identity，无额外缩放 | identity，无额外缩放 |
| 世界尺寸 X/Y/Z（glTF 米制） | 0.505501 / 0.254089 / 0.405501 | 1.164944 / 0.889291 / 0.496543 |
| 最低 Y | -0.000015959 | -0.000499497 |
| 几何属性 | POSITION / NORMAL / TEXCOORD_0 | POSITION / NORMAL / TEXCOORD_0 |
| 皮肤 / 动画 / morph | 无 | 无 |
| 必需扩展 | 无 | 无 |

这里不是只相信 accessor 声明：脚本实际读取 BIN 内每个 POSITION、NORMAL、UV、索引，验证 bufferView 范围、有限数、索引范围和三角形整除；实际 POSITION 极值与 accessor.min/max 完全一致，再经节点矩阵组合计算 world bounds。完整浮点结果在 `asset-inspection.json`。

两个 glTF 都是一个根节点、一个 primitive；没有隐藏的多个摆放变体。glTF 原依赖与官方 include 清单逐项完全相等，没有缺文件或多余运行依赖。两个 BIN 远程 URL 位于 `/gltf/4k/` 是官方原链接，保存到各自 glTF 同目录后引用正确。

## 贴图 / UV / sampler

- 共九张 JPG，JPEG SOF 头实读均为 **1024×1024、8-bit、3 components、无 alpha**。没有像素解码或转换。
- 两个模型各三张：GL normal、diffuse、ARM。模型只有 `TEXCOORD_0`，所有纹理引用未指定 texCoord，故用 UV0；没有 KHR_texture_transform。
- crate UV0 范围约 U[0.003901,0.996040]、V[0.004015,0.996099]；bench 约 U[0.003996,0.994568]、V[0.003998,0.996007]。
- 每个 glTF 只有一个 sampler：`magFilter=9729`（linear）、`minFilter=9987`（linear mipmap linear）；wrapS/T 未声明，按 glTF 默认 repeat。未发现 Draco/Meshopt/KTX 等解码依赖。
- ARM 引用的是同一张图，不应重复加载成多个独立图像。颜色按 sRGB、法线和 ARM 按数据处理；此处是接入要求，未改原文件。

## 必须保留的风险记录

1. **crate 原材质 `alphaMode: BLEND`，但实际 baseColor 为三通道 JPEG，baseColorFactor alpha=1，也没有 vertex color 或其他 opacity 引用。** 图像 `name` 含 `diff-opacity` 字样不等于文件含 alpha。本次 13 文件没有单独下载 Alpha/Opacity。不能声称实际纹理镂空已得到保留，也不能直接给全模型设置 alphaTest 解决；接入后应对照孔洞几何/官方意图决定保持原导出、改不透明路径，还是另行取得作者 opacity。当前数据会产生完全不透明的片元 alpha，却走 BLEND 分类，可能造成多余排序和与邻近透明物件的关系问题。
2. **两件模型均未声明 `occlusionTexture`。** ARM 只作为 `metallicRoughnessTexture`，因此 R 通道 AO 并未通过标准 glTF 材质自动使用。不能把导入结果称为完整三通道都已接入。是否在适配层显式连接 AO，需后续独立对照，不能修改本地原字节或提升全局对比冒充修复。
3. crate 的 `baseColorFactor=[1,0.40816283226013184,0,1]`，金属度0；bench baseColorFactor 未声明（默认白），金属度0。两者 roughnessFactor 未声明（默认1）。保留这个乘色因子，不能忽略后再用全局色调补颜色。
4. bench 为 `doubleSided:true`、默认 `OPAQUE`；crate 未声明 doubleSided（默认false）。不要为了统一而给所有物件开双面/透明，也不能在未看背面前去掉 bench 的双面。
5. 目前确认的是实际尺寸与结构，不是模型朝向、坐凳舒适性、视觉孔洞、纹理观感或碰撞验收。模型最小Y仅略低于0，落地可依据 bounds 消除这点偏差；没有理由把整个模型任意缩放或抬高。
6. crate 成本不低：4 个原始实例就是 **23,360** 几何三角面；共享纹理/实例化不减少这个数量。bench 适合低成本复用。两件各1 primitive/material 不等于包含阴影/轮廓后的总共只1 draw；没有实跑性能数据。
7. shutter 仅取三张原始贴图，没有下载其 glTF/2.37MB BIN。它应服务现有卷帘面；不能声称已审计其未下载几何。原 API 数据保留在 meta 中。

## 产物和复查命令

- `download-receipt.json`：全部原文件相对路径、来源 URL、字节、官方匹配 MD5、实际 SHA256。
- `asset-inspection.json`：节点矩阵、完整边界、primitive/accessor/material/image/sampler 记录和 JPEG 尺寸。
- `SOURCE-LICENSE.md`：作者、官方来源和 CC0 依据；没有声称单独下载文件包含 LICENSE。
- `download-selected.cjs`：固定推荐清单下载、长度+MD5验证后才接受文件，生成SHA256收据；已运行 exit0。
- `audit-downloads.cjs`：完全离线、无依赖安装的实际二进制检查；已运行 `node audit-downloads.cjs`，exit0，13文件重验通过。

当前素材和审计文件已冻结，等待 root 分配后续接入或视觉验收。没有 GPU、GitHub 或 fixture 写入。
