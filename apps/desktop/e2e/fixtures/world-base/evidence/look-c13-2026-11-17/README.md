# 第13轮：真实素材回验与墙面收边反馈

运行源码固定为 `1677ea3167905a180d8b26c48a4b0c0ffece4325`，来自 [C酱交接](https://github.com/aa15119557034/agent-review-room/pull/254#issuecomment-6947670677)。本轮未改运行源码。RTX 3060 正常运行与七机位定向实拍已完成，CPU 检查和 Windows CI 已跑。分类桶配色、圆弧纹去除、台面外侧共面带修正可保留；**公寓墙的斑团对比仍需局部精修，P2 和整体美术验收未完成。**

## 实拍判断与下一棒

| 实图 | 观察与结论 |
| --- | --- |
| [21 洗衣店正面](./diagnostic/21-front-eye-ao-on-capture-2.png) | 两桶暗盖可读，机器与青墙保持主次。远处 5F 向阳面灰斑明显，层间呈重复排列感；这仍会抢过窗和楼层构件。 |
| [24 洗衣店近景](./diagnostic/laundry-details-ao-on-capture-2.png) | 原 plaster 圆弧消失，但灰团和黑点仍明显；不能称为细腻颗粒。真实周转箱和玻璃后的机器可见。 |
| [23 服务角](./diagnostic/service-corner-ao-on-capture-2.jpg) | 两桶配色更克制，盖子比桶身深一档。原箱筐、卷帘、标签与构图保持，簸箕仍有遮挡。 |
| [20 楼后](./diagnostic/20-rear-eye-ao-on-capture-2.jpg) | 灰楼整面重复斑团在这个视角更明显。楼梯、走廊及清扫用品未见新增结构遮挡；二层包裹仍在栏板后。 |
| [街道近景](./diagnostic/street-detail-ao-on-capture-2.jpg) | 电表和管线清楚，未见新增遮挡。 |

林离与独立只读审查均实际查看以上五机位实拍：林离查看原 PNG，独立审查查看 JPEG。下一棒请 C酱只对**公寓墙的独立材质**收低纹理对比，保留基色、结构阴影和少量细节；不要再只缩 UV，也不要改共享 `M.concrete`，以免连带改变台面及其他构件。既有桶配色、物件数量和布局、太阳／天空／烘焙与三角预算保持。原 concrete 除色斑／颗粒还含横竖中线，不能把源纹理描述成“只有颗粒”。

## 实际运行与性能

两次均只跑一次，完整报告、日志和加载失败原样归档，不筛选绿色结果。

| 运行 | 实际进程观测 | 结果 |
| --- | --- | --- |
| `node scripts/baseline.cjs --scene=combined --electron=D:/codex/2026-11-16/world-implementation/runtime-path-probe/electron.exe --stills --output=artifacts/gpu-town-c13`（cwd=fixture） | session 95839，PID 5924，exit 1 | stage complete，renderOk=true，transportClean=false；menhir.glb、crate.gltf 两次 ERR_ABORTED，无 JS 异常。 |
| `node handoff/x51-c13-diagnostic-gpu.cjs`，输出 `artifacts/gpu-look-c13-v1` | session 62458，PID 30548，exit 1 | 21 图完整、renderOk=true，transportClean=false；menhir.glb、crate.gltf、crate.bin 三次 ERR_ABORTED，无 JS／HTTP 异常；源码、驱动与九个真实资源未变，恢复状态前后 SHA 一致。 |

正常基线四机位 FPS：街道 **64.9995**、站区望港（station-port）**65.0016**、鸟瞰 **64.3571**、店内 **64.9998**；第三／第一人称 **64.9995／64.9998**，移动距离 **9.4670／9.3716 m**。六段 p95 均 **15.5 ms**，14 项行为、look 与真实 W 步行检查通过。初始 978 帧有 4 帧 >20 ms，最长 30.9 ms；鸟瞰 201 帧中 2 帧 >20 ms，最长 30.8 ms，其余五段本次未采到 >20 ms 帧。不能据此称无掉帧、零性能成本或长时稳定性已验收。

七机位定向均为默认 AO、time=14，逐机位 warmup／capture-1／capture-2 共 21 图，七组 capture-1／capture-2 全图一致；本轮没有 AO-off、HDR 或阴影 ABA 实验。04 店内与上一轮密度及 C12 的同机位默认 AO 图全图 PNG 相同；01 对密度首版有 524 个变化像素，其中 >1 的差异集中在 x804..852、y361..390 的远处区域，**不将它们全部归因为樱花动画**。street-detail 对密度首版有 1,322 个变化像素，虽肉眼未见新增遮挡，也不称全图不变。其余像素比较与相机、素材、恢复记录见完整报告和 analysis；静态重复稳定不代表所有移镜情况通过。只选预定的第二张原图入库，所有 21 张原 PNG／JPG 的大小和哈希仍列入 capture-index。

## 几何、支撑与资源生命周期

- `node x51-c13-city-cpu.mjs` 实际 exit 0，原结果、stderr、源码 SHA 与脚本保留。CPU 使用占位图像像素，只用于几何／材质／释放检查，不作为实拍证据。
- 镇边仍 **29,553 三角**，严格 `<30000` 门槛下最多还能加 446；已有密度增量 444、站区增量 132 均未变。无新增纹理像素或纹理缓存项。
- 新旧 n=2 分类桶均 72 三角，GB 位置／法线／UV／索引／标志一致；只桶身与盖的颜色变化，标签颜色和图集 UV 不变。原上游在 n=2 时 rng 调用实际为 0。服务角碰撞和各实例 footprint 创建保持。
- 五块台面各边向内 5 mm，y 端点未变，实际 Float32 外侧分离量为正；原 9 cm 外侧竖面共面带消除，侧面藏在不透明压顶内。未声称移除了所有内部／底部重叠。六阶结果与上一轮完全相等。
- 公寓墙 600 个投影三角从 plaster 转用现有 concrete，实际面 UV 为 3 m／张。源贴图圆弧不再应用，但色斑对比仍由实图评判。
- 城市报告材质 29、几何 26、借用纹理 13。连续两次 dispose 中，根网格几何 26／材质 24 各释放一次；共享纹理及抽查的原站区伞架几何／材质释放 0。owned 集合还含非根／customDepth 路径，不能把 24 写成所有材质总数。

## CI 与证据边界

`node scripts/verify.mjs` 的 [Windows 实际 job](https://github.com/aa15119557034/agent-review-room/actions/runs/44080831343/job/134030665007) 完成于 2026-11-17T12:17:16Z：**1615／1615 测试、9 类型检查、2 构建，20 步均 code 0**。完整实际日志和 exact-head 校验归档于 ci；C酱的 Linux 1507 仅为她的独立报告，不替代本机和 Windows 证据。

原运行源码、九个官方资源大小／MD5／SHA、驱动与过程记录逐项核对；完整失败报告与日志 lossless gzip 保存。历史 [密度首版与快照修补](../density-2026-11-17/README.md) 及 [C12](../look-c12-2026-11-17/README.md) 原样保留，不把旧采样重标为本轮。这里的记录只支持局部材质／几何／短时性能结论，未做生产集成、全场导航或整体风格验收，PR 继续 Draft、不合并。
