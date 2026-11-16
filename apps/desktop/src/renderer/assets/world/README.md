# 共享小屋 3D 资产

## 原创角色制作切片（2026-11-16）

`claude.glb` 是本项目新制作的真实网格、骨骼和裙装形变资产，与下方 Quaternius 技术基线分开。根据用户给出的角色图提取铜橙长发、花饰、奶油白/深色/铜橙衣装特征；没有把参考图打包、贴在人形平面上或直接导出参考图。作者：林离（Astra 实现）；主线程独立验收仍在进行。

- 运行 GLB：12,900,376 字节；286,684 三角形、13 材质/primitive、19 骨骼，1 个 scene。文件没有默认 Cube、灯、相机、测试椅或第二本书。
- 形变：`Seated_Cloth`、`Walking_Cloth`、`Blink`。骨骼使用 `upperarm_l/r`、`lowerarm_l/r`、`hand_l/r`、`thigh_l/r`、`calf_l/r`、`foot_l/r`；模型 glTF 朝 +Z，脚底接近 Y=0。头饰不应用总包围盒重新改变人物身高。
- 可复建源：`apps/desktop/scripts/world-assets/build-resident.py`，制作灯光 `studio.py`，同版姿态检查 `review-resident.py`，导出 `export-resident.py`。在现有 Blender 5.2.2 LTS 运行，未安装或升级软件。
- 本机可编辑源工程：`D:\codex\2026-11-16\world-implementation\art-authoring\claude-resident-studio.blend`。Git 内保留上述可重建脚本；原始用户工程未修改。
- 固定版本检查图和制作统计：[近景/全身/侧面/坐姿](../../../../../../docs/design/world-art-review/README.md)。站立与坐着读书已实际渲染；游戏镜头、走路/做饭/吃饭/睡眠、另外角色和整体性能仍待本轮集成验证。

局部头发重拓扑会产生数值级的反向重复薄片；生成器在该输出边界移除面积小于 `1e-12 m²` 的退化面与重复面，再建权重/形变，并要求 Blender 的网格检查不再修改拓扑。皮肤和虹膜使用顶点色，其他材质用固定底色。导出器针对其他材质提示“活动顶点色未被材质使用”是预期的；不得忽略无效网格或无关 Scene 导出的警告。

## 首片技术基线

来源核对日期：2026-11-16。仅使用作者官方发布渠道。

- 作者：Quaternius；[Universal Base Characters](https://quaternius.com/packs/universalbasecharacters.html)，[官方 itch.io 下载页](https://quaternius.itch.io/universal-base-characters)。免费 Standard ZIP，128,968,391 字节。
- 实际归档中的 `License_Standard.txt` 明确写明 **CC0 1.0 Universal**，保留原文为 `QUATERNIUS-LICENSE.txt`。官网也标明 CC0。未采用付费 Source 内容。
- `character.glb`：`Base Characters/Godot - UE/Superhero_Female_FullBody.gltf` 与 `Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_Long.gltf`。10,156,588 字节；SHA-256 `8aacc87c0391ab9ff24f68a3ea7116d2838ba0100b594e8a7b64fd172e821e76`。
- `player.glb`：同目录 `Superhero_Male_FullBody.gltf` 与 `Hair_SimpleParted.gltf`。9,315,640 字节；SHA-256 `4440ddbeb38a502682113a42cb2a8a2eeb191dc618127f6186f842c6ca4ef2a6`。

派生操作：保留原网格、UV、humanoid rig、skin weights 和 inverse bind matrices；把头发的同名骨骼绑定到身体骨骼；纹理缩到最长边 1024 并内嵌为 GLB。官方包存在 `T_Eye_Normal_png.png` / `T_Hair_1_Normal_png.png` 的引用与实际文件名差异，构建脚本显式对应到包内实际的 PNG。构建脚本为仓库 `scripts/world-3d-pack-character.cjs`，输入为解压后的 `Universal Base Characters[Standard]` 目录，分别运行默认与 `--male`。

原始基础身体只有内衣。运行时构建独立的普通短袖 T 恤：按肩、胸、腰、衣摆缝合躯干布面和两侧短袖，绑定现有 humanoid 骨骼；衣服下面的身体面被遮掉，避免动作中穿出。长裤从身体表面派生并保留原始 skin weights。不同居民按现有秘书颜色穿衣，并使用不同发色；当前仍共享同一女性基础脸型/长发，玩家使用男性基础模型。这是首片基础美术，不是最终个性化人物美术，也不具备布料物理。

房屋、窗门、地板、炉灶、橱柜、沙发、桌椅、床、书架、灯、植物等在 `house-model.ts` 以真实三维网格构建；这些是本项目原创建模，未打包 Kenney 家具。静态家具按材质合批，房间地板单独保留点选映射。

动作没有假称来自素材包：目前走路、读书、做饭、吃饭、休息和睡眠由确定性的本地骨骼姿态/循环表现。没有完整动捕、手指握持、口型、布料或物理碰撞；整理/摆桌只沿用一般站姿与移动，不能称为专属完整动画。只有一份可交互小说与锅的 3D 实例，依据 `world.items.at/usedBy` 呈现，装饰书架上的书脊不代表可取用库存。
