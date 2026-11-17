# C16 meadow 生命周期只读复核

源：50e190b092fb2b30ab9ed19a28302d5638f947f4。具体文件 SHA 见 `x51-c16-meadow-lifecycle.json`。未修改 fixture，未运行 GPU/编译 GLSL/性能采样。

## 发现：P2，同一 JS realm 创建第二个 look 时绑定旧 townUniforms

`src/look.js:198–217` 获取模块共享的 Shell.prototype，只包装一次；包装函数在第 203 行捕获首个 createLook 的 townUniforms。第二个 look 的 applyIsland 因 wbTownPatched 跳过安装，所有新建/替换/延迟创建的 meadow 材质仍引用首个 look。第二个 look 的 terrain 使用自己的 uniforms，故地面和草花控制分裂。第 249–251 行新 look 的 setter 无法关闭自己的 meadow。

实际 CPU 重现（真实 Three r187、Pipeline 构造器、createLook、Meadow、Shell.material；仅非 meadow 的岛屿 shader 使用插入点测试夹具）：

- look A 设 rect=[10,20,30,40]，之后 strength=0。
- look B 设 rect=[110,120,130,140]、strength=.75：B terrain 使用新 rect，B grass 仍为 A rect/strength0。
- A 改 rect=[-1,-2,1,2]、strength=.9，B grass 随之改变。
- B strength=0：B terrain=0，B grass 仍 .9。
- B Meadow.setQuality 重建仍绑定 A；未经 applyIsland 的第三个 Meadow 也被全局包装自动改变。

这是确定可复现的 API 生命周期问题，不是目前 main 单次初始加载失败。`main.js:90–94,127–134,163–187` 只 init 一次；页面整页重载会重置模块。当前界面没有已发现的同 realm 重建入口。若本轮只验收一次启动，不应把该问题写成已发生的首帧阻断。

最小修复方向：让包装读取当前 Meadow 的所有者参数，而非首个 look 闭包。例如模块级 WeakMap<Meadow, townUniforms>、applyIsland 注册当前 meadow、全局工厂按 this.meadow 查表；未注册 Meadow 返回原材质。保持一次包装但不捕获任何实例参数。不要在 dispose 时盲目全局还原原型，避免破坏仍存活实例。是否采用这种机制由 root 决定，本次没有实施。

## 首场景及质量重建：目前链路正确

- `island.js:195` 创建 Meadow；`Meadow` 构造器经 `setQuality` 只造 Shell/geometry，pool 为空（`meadow.js:447–509`）。首次 material 在 `mesh(i)` 第 477 行延迟创建。
- main 在第一次 `island.update` 前 applyIsland 并 setTownGreenery；update 先于 look.render。CPU 实测首个 grass/flower 与 terrain 共享正确 uniforms；strength0 对二者生效。
- 同一个 look 的 Meadow.setQuality 真实释放旧 material/geometry，再造新 Shell；新材质仍正确绑定这个 look，旧 grass dispose 事件实测一次。不会随每次质量切换叠加包装。
- grass/flower shader 实际插入成功，各自只有一个 wbTownMask 定义；xz 在注入位置前已声明（meadow.js:136/277），grass vTint 后续未被重置，flower keep 在 fade/early-return 前应用（290–302）。未看到本轮确定的首次编译语法错误；CPU 字符串检查不能代替 GPU 编译。

## 较低风险：预建 pool 替换会丢 uCell，下一次正常 update 修复

`look.js:219` 给每个 mesh 换全新 material，旧 material dispose 实测一次，未损坏 mesh 或共享 geometry；但原 uCell=[100,200,30,.3] 被重置为 Three Vector4 默认 [0,0,0,1]。若对已活跃 meadow apply 后直接 render、不 update，草花位置/尺度错误。

当前首次 pool 为空，主循环每帧又先在 `meadow.js:578–579` 重写全部活跃 cell 的 uCell，所以当前 main 路径不触发。可在未来需支持热替换时保留 per-cell uniforms，或明确要求下一次 update 后才能 render；不应据此声称本轮已有画面错位。

## 泄漏、重复注入与成本的范围

- 新 global wrapper/flag 未撤销，确定保留首个 townUniforms 并污染同 realm 后续 Meadow；只证明少量 uniform 对象常驻与错误绑定，未证明 renderer/RT/GPU 材质持续泄漏。
- 替换旧池会释放旧材质，首次池为空不会发生旧 program 回收再编译；正常延迟创建仍是原来的每 cell 一个 ShaderMaterial，没有新增纹理或 RT。着色代码按 grass/flower 类型一致，uniform 值本身不是 shader program key。
- `applyIsland` 对同一个岛调用两次会重复 GLSL 声明，但原有 BANDS 等注入本来就非幂等（172–184）；不能将整个既有非幂等契约算成本轮新增回归。当前调用一次。
- 花的筛减在 vertex shader 做 early-return，不会降低 CPU instanceCount 或提交的 triangle 统计；额外 mask/hash 算术与可能减少的片元工作需实际 GPU 判定，不能仅凭花变少宣称性能提升。
- createLook 没有完整 dispose API；上游 Pipeline.dispose 仅释放 RT（pipeline.js:117–119），不是本轮新增。不要为了修全局 uniform 绑定扩成整套生命周期重构。

## 实际命令与产物

`node D:\codex\2026-11-16\world-implementation\handoff\x51-c16-meadow-lifecycle.mjs > D:\codex\2026-11-16\world-implementation\handoff\x51-c16-meadow-lifecycle.json`

实际 exit 0；JSON 记录上述对象身份、值、释放事件、shader 定义次数与源码 SHA。没有 GPU、DOM、贴图加载或场景渲染。脚本末尾释放自身创建的材质/geometry/Pipeline CPU 对象；原型改变仅存在于已退出的 Node 进程中。
