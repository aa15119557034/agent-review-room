# 共享小屋 3D 资产

来源核对日期：2026-11-16。仅使用作者官方发布渠道。

- 作者：Quaternius；[Universal Base Characters](https://quaternius.com/packs/universalbasecharacters.html)，[官方 itch.io 下载页](https://quaternius.itch.io/universal-base-characters)。免费 Standard ZIP，128,968,391 字节。
- 实际归档中的 `License_Standard.txt` 明确写明 **CC0 1.0 Universal**，保留原文为 `QUATERNIUS-LICENSE.txt`。官网也标明 CC0。未采用付费 Source 内容。
- `character.glb`：`Base Characters/Godot - UE/Superhero_Female_FullBody.gltf` 与 `Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)/Hair_Long.gltf`。10,156,588 字节；SHA-256 `8aacc87c0391ab9ff24f68a3ea7116d2838ba0100b594e8a7b64fd172e821e76`。
- `player.glb`：同目录 `Superhero_Male_FullBody.gltf` 与 `Hair_SimpleParted.gltf`。9,315,640 字节；SHA-256 `4440ddbeb38a502682113a42cb2a8a2eeb191dc618127f6186f842c6ca4ef2a6`。

派生操作：保留原网格、UV、humanoid rig、skin weights 和 inverse bind matrices；把头发的同名骨骼绑定到身体骨骼；纹理缩到最长边 1024 并内嵌为 GLB。官方包存在 `T_Eye_Normal_png.png` / `T_Hair_1_Normal_png.png` 的引用与实际文件名差异，构建脚本显式对应到包内实际的 PNG。构建脚本为仓库 `scripts/world-3d-pack-character.cjs`，输入为解压后的 `Universal Base Characters[Standard]` 目录，分别运行默认与 `--male`。

原始基础身体只有内衣。运行时从身体表面派生独立、带原始 skin weights 的上衣和长裤网格；上衣重塑宽松的躯干外轮廓，另外建模领口、袖口和衣摆。不同居民按现有秘书颜色穿衣，并使用不同发色；当前仍共享同一女性基础脸型/长发，玩家使用男性基础模型。这是首片基础美术，不是最终个性化人物美术，也不具备布料物理。

房屋、窗门、地板、炉灶、橱柜、沙发、桌椅、床、书架、灯、植物等在 `house-model.ts` 以真实三维网格构建；这些是本项目原创建模，未打包 Kenney 家具。静态家具按材质合批，房间地板单独保留点选映射。

动作没有假称来自素材包：目前走路、读书、做饭、吃饭、休息和睡眠由确定性的本地骨骼姿态/循环表现。没有完整动捕、手指握持、口型、布料或物理碰撞；整理/摆桌只沿用一般站姿与移动，不能称为专属完整动画。只有一份可交互小说与锅的 3D 实例，依据 `world.items.at/usedBy` 呈现，装饰书架上的书脊不代表可取用库存。
