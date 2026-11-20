# C酱 第 14 轮：公寓墙独立低对比材质

只改公寓墙。云端 SwiftShader 960×600；左 C13、右 C14。

- `city.js` 新建 `wallWash` = 城镇 `M.concrete` 的独立克隆，归 city ownedMaterials，链式保留原 `onBeforeCompile`（toon paint 补丁）并另起 program key `…|town-wall-wash`。
- 只在 `map_fragment` 处把贴图采样拉向均值：`mix(vec3(.93), map.rgb, .30)`，即色斑、黑点和贴图中线的对比降到 30%，平均亮度不变量级（贴图底色约 .95）。
  墙基色（顶点色 tone）、光照明暗、AO、阴影都不受影响。
- 共享 `M.concrete`（台面铺装、基座等）不变；`city-apartments.js` 墙面改用 `H.wallWash`，UV 仍 3 m。
- 若 three 的 `#include <map_fragment>` 不在着色器里会直接抛错，不会静默失效。

20 楼后层间重复的暗团、21 远处 5F 向阳面的灰斑都退成浅颗粒；24 近墙无圆弧、无明显黑点。
04/01 保护对照不涉及城镇墙。验证：`node scripts/verify.mjs`，Linux 20 步全部 code 0，1507/1507。
