# C酱 第 17 轮：城镇草色接到过渡地面；meadow 参数归属

修林离第 16 轮实测交回的两项（#254）。云端 SwiftShader 960×600。草、花、绿篱、砾石的配色参数都不变。

## 1. 北侧亮绿细带（P1）

**原因**：`transition.js` 建过渡环时复制了当时的 terrain 片元着色器，并展开了它的 uniforms。第 16 轮只给 terrain 注入了 TOWN。站内的两块边缘混合（ground / levee）又是从过渡环复制的，所以这三份材质都没有变色。

**改法**：`applyIsland()` 在同一处、按同一套代码，给 terrain 和 transition 两份材质都注入 TOWN，并挂上这个 look 的同一组 uniform 对象。边缘混合是后来在 `createStation` 里从 transition 复制出来的，会自然继承同样的着色器和同一组 uniform。没有加第三份补丁，也没有改羽化范围。

**核对**（`material-check.txt`）：
- 场景里所有含 `meadowTint(` 的地面材质共 4 份：terrain、transition、ground 混合、levee 混合。
- 这 4 份的 `uTownRect` 都是同一个对象，着色器里都有 `wbTownMask(P.xz)`。
- 林离给的两个人眼机位，开（strength 1）/ 关（0）的对比见 `north-seam-*-on-vs-off.jpg`：开的时候北缘没有亮绿细带，岛面和过渡环颜色连续。

## 2. 第二个 look 串用第一个 look 的参数（P2）

**改法**：
- `Shell.prototype.material` 的包装只装一次，而且不再捕获任何 look 的闭包。
- 每次创建材质时读 `this.meadow.wbTownUniforms`。这个字段由收养这个 Meadow 的那个 look 在 `applyIsland()` 里设置。
- 没有被任何 look 收养的 Meadow，直接拿到上游原样的材质。
- 同一个 Meadow 被重新收养时，已有的 pool 材质会按新 look 重建。

**核对**：
- 当前 meadow 新建的材质，用的是 terrain 那组 uniform。
- 另外新建一个 Meadow（`low` 质量），它的草和花材质都没有被注入（`freshMeadowPatched` / `freshFlowerPatched` 均为 false）。
- 双 look 的完整复现在云端没有跑，以林离的 CPU 复现为准。

## 没动

- 配色参数，城镇 foliage，砾石。
- 太阳、天空、烘焙光照、全局光。
- 几何：镇边仍是 29,933。

## 验证

`node scripts/verify.mjs`：Linux 20 步全部 code 0，1507/1507。
