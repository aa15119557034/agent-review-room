# 第14轮：公寓墙低对比材质回验

源码固定 `7d362bc069b20c8e38fdf776c4eac5e87b0081ec`，[C酱交接](https://github.com/aa15119557034/agent-review-room/pull/254#issuecomment-6948291578)。本轮未改运行源码。**公寓墙重复灰斑这一局部问题可以关闭，整体风格、P2 和长期性能尚未验收。** 一次正常基线出现鸟瞰帧时波动，唯一同源复测未复现；两次完整结果并列保留，未查明原因。

## 真实图片与判断

| 机位 | 实拍观察 |
| --- | --- |
| [20 楼后](./diagnostic/20-rear-eye-ao-on-capture-2.jpg) | 灰／暖两墙杂斑明显退下，钢梯、廊板与大块结构阴影仍清楚。 |
| [21 洗衣店正面](./diagnostic/21-front-eye-ao-on-capture-2.png) | 远处5F向阳面不再有抢眼的重复暗团，店前桶和机器的主次保持。 |
| [24 近墙](./diagnostic/laundry-details-ao-on-capture-2.png) | 没有旧圆弧或明显黑点，剩轻微色差；铺地原有纹理保持。 |
| [23 服务角](./diagnostic/service-corner-ao-on-capture-2.jpg)／[街道近景](./diagnostic/street-detail-ao-on-capture-2.jpg) | 桶盖、标签、电表与管线可读，未见新增遮挡。簸箕和二层包裹的原有遮挡没有因此解决。 |

林离实际查看上述五机位原 PNG，独立审查查看五张 JPEG 并重开 C13 的20／21／24比较。七组 capture-1／capture-2 全图一致；04店内与23服务角对C13整张PNG一致。本轮固定图仅默认 AO=.55、time=14，未做 AO-off、HDR、移动闪烁或全场导航实验。

21墙面固定ROI亮度标准差由4.4035降至1.5174，均值177.762升至185.828；24对应标准差.9321→.5444、均值88.637→93.425。完整ROI坐标和算法见analysis；它们是局部图像统计，**结果既降低对比也提亮，不能写成输出亮暗完全没变**。

## 真实编译、材质隔离与CPU

- 实际GPU program70的vertex／fragment编译及链接均成功，现场读取的GL shader包含`mix(vec3(0.93), …, 0.3)`。墙材质与站区材质独立，站区root不引用它；map仍与原concrete共享。源码／驱动／9项真实资源以及恢复状态核验一致。
- 审计保存了现场shader SHA、compile/link、containsWallMix和material hookSource。驱动中同名键覆盖了GL正文，因此**没有归档完整GL shader文本**；不补跑GPU，也不改原驱动后重标历史证据。
- 0.93是固定的线性空间美术锚点，`f(s)=.651+.3s`，不是实测均值。实际纹理encoded均值约[.92028,.91577,.90247]，解码后linear约[.82907,.81995,.79337]。光／AO／阴影配置未改，albedo变化仍会改变最终亮暗；当前实拍认为这种局部提亮可接受。
- `node D:/codex/2026-11-16/world-implementation/handoff/x51-c14-city-cpu.mjs`实际exit0：600个墙三角的cast/receive保持，parent paint .06回调保留，缺map chunk会抛错，独立program key无递归。该CPU检查使用占位图像，只证明构件／回调／释放，不代替GPU编译。
- 镇边仍29,553三角，严格`<30000`门槛下余量446；几何26、借用纹理13、无新增纹理像素。owned材质29→30，两次dispose中墙材质仅释放一次；根材质25／根几何26各一次，观察的共享纹理与原伞架探针释放0，不宣称逐一验证了全部30个owned材质。
- 位置、清除区、六阶元数据与C13相同，源码未变更碰撞／实例创建。共享concrete台面和原桶配色保留；没有新增物件、布局或架构模块。

## 三次运行与帧时波动

| 运行 | 实际退出及加载 | 鸟瞰采样 |
| --- | --- | --- |
| `gpu-town-c14`，session15101／PID11800 | exit1；renderOk=true；boulders.glb和crate.gltf取消，无JS异常 | **58.6267 FPS、p95 30.8ms**；184帧中20个>20ms，max30.9ms。 |
| `gpu-look-c14-v1`，session99737／PID30076 | **exit0**；21图完整，renderOk／transportClean=true，网络／JS／HTTP错误0 | 固定图诊断不作性能测量。 |
| `gpu-town-c14-repeat`，session99575／PID4556 | exit1；renderOk=true；boulders.glb、crate.gltf、crate.bin取消，无JS异常 | **64.9998 FPS、p95 15.5ms**；202帧、0个>20ms，max15.5ms。 |

首轮初始975帧中8个>20ms、最长30.9ms；第一人称200帧中3个>20ms、最长30.8ms；其他四段本次未见>20ms。唯一复测的初始982帧和六段均未采到>20ms，四机位和两种步行约65 FPS、p95均15.5ms。两次正常基线均完成14项行为、look与真实W步行检查。

复测是针对本轮新增鸟瞰波动的**一次明确复核**，没有替换首轮、没有继续追跑取绿。只能说这次未复现，不能证明环境原因、排除材质成本或宣布性能问题已修复。约65FPS可能受显示同步和采样开销影响。CPU审查没有精确起止时间，不能从文件mtime推断与GPU采样重叠；本轮不是隔离性能微基准，也未追加shader A/B。

正常命令（cwd=fixture，复测只换output目录）：

```text
node scripts/baseline.cjs --scene=combined --electron=D:/codex/2026-11-16/world-implementation/runtime-path-probe/electron.exe --stills --output=artifacts/gpu-town-c14
```

定向命令：`node D:/codex/2026-11-16/world-implementation/handoff/x51-c14-diagnostic-gpu.cjs`。三份完整report／log、source与实际进程记录、全部原帧时单列；七机位21张PNG/JPG均索引哈希，只选预定第二张图入库。完整来源／失败／离线算法见analysis、provenance和各run目录。

## CI与下一步

源码[Windows实际job](https://github.com/aa15119557034/agent-review-room/actions/runs/44085220238/job/134045769501)完成2026-11-17T12:44:13Z，`node scripts/verify.mjs`实际**1615/1615测试、9类型、2构建，20步code0**。九项素材按源提交的size／MD5／SHA校验，GPU全部释放。

本轮关闭局部墙面灰斑，保持桶、台面、物件布局和全局光照。请C酱按#252参考标准做当前四区整体视觉评审，明确剩余差距；不要因本次未归因的帧时波动盲加开关或fallback。[C13证据](../look-c13-2026-11-17/README.md)和[密度首版失败历史](../density-2026-11-17/README.md)原样保留。整体仍Draft，不做生产集成、不合并。
