# X-51 二次元风格化植被验收

江浩要求用**日系二维动画背景的观感**作为植被的美术验收目标。树木、灌木和近处草簇用 Blender 自制，保留可编辑源文件和游戏内对应的 GLB。最终以傍晚站区实拍判断。

## 交接图怎么用

- [交接里的街景 1–11](https://github.com/aa15119557034/agent-review-room/tree/0bfc08e5cbdcba3f7fc03ba293ad23e41e240430/images)主要看形和摆放。[第 3 张](https://github.com/aa15119557034/agent-review-room/blob/0bfc08e5cbdcba3f7fc03ba293ad23e41e240430/images/3.jpg)看树、灌木与栏杆的高低遮挡，第 6、10 张看街边修剪植物如何围合空间。
- [交接图的植被细节](./reference-ecology.jpg)主要看色与光。三格分别来自 StylizedEcoKit 生态-2、参考 2 草地花丛、参考 3 俯视河流。看大面积冷暖色、成组的树冠轮廓、边缘小叶形和草木贴地的过渡。图板保留了相关局部，供这里的美术评审。场景里的网格和贴图由本项目制作。

## 画面要求

| 范围 | 实拍里应该看到的效果 |
| --- | --- |
| 阔叶与针叶 | 缩到场景远景时仍能辨出树种和主轮廓。阔叶由 3–5 个连贯大块面组织，顶部暖绿、侧面过渡、底部冷绿。小叶边集中在外轮廓和枝间透空。近处检查内芯有没有露出大片平面，远近切换时保持轮廓、层次和色相。 |
| 短草和地面 | 先读到画出来的大块暖黄绿和冷蓝绿，再读到近处窄草叶、边缘花簇。草根跟地面共用颜色和明暗。细叶在约 25 米并入地面，铺草与外侧原地面用 5–8 米的柔和过渡。原机位对照草底局部的颜色和亮度。 |
| 树篱与灌木 | 连续但高低有节奏，转角和树脚有前后两层，草、矮灌木和树冠连成整体。树篱的叶顶偏暖绿，侧面、底部偏冷绿，与阔叶属于同一套色域。 |

复拍用原交接机位 `(66.8, 119.1) / 273°`、树篱角部近照和阔叶近远景。同光照排参考、新版、原版，补灰度和局部裁切。色相、剪影、疏密和过渡都直接看图验收。

## 制作参考

- 二次元大场景的形、色和组合原则。[miHoYo GDC 美术演讲](https://gdcvault.com/play/1027539/-Genshin-Impact-Crafting-an)
- 先构建简单的大色块，再用少量叶形补轮廓和迎光侧，按距离收细节。[SIGGRAPH《Stylized Trees and Landscapes》](https://history.siggraph.org/wp-content/uploads/2022/12/2014-Poster-97-Murphy_Stylized-Trees-and-Landscapes.pdf)
- Blender 里先设计树冠外包络，再布置裁切叶卡。以包络法线统一冠层受光，搭配整冠由上而下的颜色渐变。[Xun Zhang 的 EvoVision 制作拆解](https://xun.archi/ecovision)
- 手绘草叶、叶卡加上地表混色的实际场景案例，以及用地面色给每丛草取色的 Three.js 代码。[Jay Creations 手绘研究](https://jay_creations.artstation.com/projects/OGq1Ok) · [stylized-scene](https://github.com/dedekpo/stylized-scene)
