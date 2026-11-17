# C17 meadow 生命周期复核

源码头 `0184c79d94094c7d76378302592572bf367be6c7`；`src/look.js` SHA256 `25b0d55bf2b071c8645142b5307c043d9ff0556fad2c9238b9c0538341500c7f`。结论：本次要求的 C16 第二 look 参数串用缺陷已在真实材质工厂 CPU 断言中修复，未发现本轮生命周期阻断项。这里不是 GPU 渲染或泄漏验收。

## 实际代码与修复机制

- `src/look.js:205–227` 仍只包装一次共享 Shell 工厂，但第 210 行每次从 `this.meadow.wbTownUniforms` 获取当前所有者；第 211 行未注册 Meadow 直接返回原厂材质。包装不再读取首个 look 的 townUniforms。
- 第 228 行先把当前 look 的 uniform 对象登记在具体 Meadow 上，再于第 229 行给其已有池逐个创建新材质并 dispose 旧材质。延迟新建及上游 `Meadow.setQuality` 新建 Shell 都经同一工厂，因此读取当前 Meadow 的归属。
- 第 190–201 行给 terrain 与 transition 注入相同 TOWN 代码，并共享这一个 look 的 uniform 对象；CPU 测试只核插入和对象身份，实际 station edge blend/GPU 接缝结果由另一路真实场景回验负责。
- setter 第 259–261 行只改所属 look 的 uniform 对象；没有增加新纹理、RT、模块或全局恢复逻辑。

## 一次实际 CPU 运行

`node D:\codex\2026-11-16\world-implementation\handoff\x51-c17-meadow-lifecycle.mjs`

实际 child exit **0**，15 条 assert 全部通过，stderr **0 字节**。另 `node --check` exit 0。运行由外部 Node supervisor 捕获原 stdout/stderr，stdout 原字节同时存 `.json` 与 `-stdout.txt`；provenance 记录命令、时间、退出码、脚本/输出和源码 SHA。没有重跑取绿。

C16 原脚本/输出均未改变。C17 保留其实际 Three r187、Pipeline、createLook、Meadow/Shell 导入和非 meadow 的轻量 shader 夹具，改为明确断言，而非仅观察旧错误值：

1. 首次空池，grass/flower 共用 A 的对象且仅注入一次；A strength0 有效。
2. 同 A 的质量重建：旧 grass material dispose 事件一次，新材料仍归 A。
3. B 在登记前的预建 grass/flower 池没有 TOWN；登记后旧材质被替换并 dispose，新材料归 B。
4. A rect `[10,20,30,40]`、B rect `[110,120,130,140]` 独立。A 改为 `[-1,-2,1,2]`、strength `.9`，B 保持自己 rect/`.75`；B strength0 后 A 仍 `.9`。
5. B `setQuality` 重建、随后 lazy 第二个 cell 的材质均归 B。
6. 第三个未注册 Meadow 的 grass/flower 顶点/片元 shader 与直接调用原厂工厂逐字相同，uniform keys 相同，未带 uTownRect。
7. 把已有 A Meadow 池交给 B：使用新的非 meadow shader holders 调用 B.applyIsland；两类旧材质各 dispose 一次、mesh 所属 geometry 不变；新池归 B。之后 A setter 不再影响它，进一步质量重建仍归 B。

第 7 项专门检验“已有 Meadow 重新收养”，并不假装同一个已注入的整岛可以随意再次 apply。脚本中明确使用新 terrain/transition/town/water 夹具以避免把既有非幂等插入契约混入本项验证。

## 边界与保留限制

- 当前 main 一次 init、首次池为空以及同 look setQuality 的材质工厂路径正常；CPU 不包含完整场景、贴图、GLSL 编译或帧输出。
- `look.js:229` 仍会把池材质的 uCell 重置为默认 `[0,0,0,1]`。正常 `Meadow.update` 在渲染前重填活跃 cell，因此当前主循环不受影响；直接在热替换后跳过 update 渲染仍不是本测试支持的契约。本轮未扩展修改它。
- 对已注入的同一 terrain 再次 applyIsland 仍可能重复声明；这是已有非幂等接口限制，不是 C17 新增回归。
- dispose 断言只证明本次被替换/质量重建的材质发出指定事件，不证明所有 GPU 资源、JS GC 或所有 owner 引用均释放。全局工厂仍存在，Meadow 持有自己的 uniform 引用；不据此宣称零泄漏。
- 不把 C16/C17 首帧或性能波动归因于包装器；本任务未启动 GPU，也未改任何 fixture 源码或 Git/GitHub 状态。
