# C14 本机真实素材与性能复核

源 `7d362bc069b20c8e38fdf776c4eac5e87b0081ec`。三次运行串行，已结束并释放 GPU；不再重复取绿。

- normal `gpu-town-c14`：session15101 / PID11800 / **exit1**；renderOk=true，transportClean=false；boulders.glb + crate.gltf 取消，0 JS 异常。
- fixed `gpu-look-c14-v1`：session99737 / PID30076 / **exit0**；21图完整、render/transport/source/driver/9assets/restore 均 true，0 JS/HTTP/network 失败。
- 唯一授权 repeat `gpu-town-c14-repeat`：session99575 / PID4556 / **exit1**；renderOk=true，boulders.glb + crate.gltf + crate.bin 取消，0 JS 异常。两份 normal 的14行为、look、真实W步行通过。

## 墙面与保护对照

相对 C13，7机位 camera/time/params/AO 完全相同，仅默认 AO=.55、time14；每机位 warmup+两帧，7对重复 PNG 完全相同。

- 原尺寸21/24均能看到墙斑减弱，20楼后钢梯及阳台投影仍清楚。21远处5F向阳面 ROI (850,320,60,60) 最终亮度均值177.7621→185.8281、标准差4.4035→1.5174；24近墙 ROI (1000,350,120,100) 均值88.6368→93.4250、标准差.9321→.5444。是**减弱纹理对比并提亮**，不是保均值处理；仍有微弱纹理，不声称全场景最终审美验收。
- 04店内、23服务角与C13整PNG字节/解码RGB一致。01为647像素变化、meanAbsRGB=.0009164/max9，>1界限x708..852/y360..391；street-detail1543像素、mean=.0029594/max10，>1界限x0..86/y92..131。未见明显构图变化，不把小差异全归樱花。
- 地基cap、bins位置/色彩与道具构图保持；固定重复相同不替代移动相机闪烁验证。没有额外AO-off、HDR、tap或shadowABA。C12历史6同机位数值仍保留，street-detail无C12对照。

## 实际材质/编译

wall-material-audit.json 来自21图后的实际 renderer/GL 回读。墙仍为独立 MeshToonMaterial clone，key带 `|town-wall-wash`；station.root不引用该clone，map与station concrete共享。真实program70 vertex/fragment编译、link均true，实际GL片段源码匹配 `mix(vec3(0.93),sampledDiffuseColor.rgb,0.3)`；GLerror=0。city仍29553tri/26geometries；materials29→30，借用13纹理、owned0、无新增texture pixels。未在GPU本轮做dispose寿命实验。

**0.93 是固定线性混合目标，非纹理实测均值。** 256×256 sRGB原图归一化encoded均值 [.920276,.915775,.902469]；按sRGB EOTF解码的CPU线性均值 [.829067,.819954,.793365]，套混合式后 [.899720,.896986,.889010]。这些是原图CPU统计，不是经过过滤的GPU采样均值。

记录限制：驱动实际读取GL shader并作SHA/混合式检查，但原文本在对象内被同名SHA字段覆盖，因此归档保存的是实际shader SHA、containsWallMix、compile/link与material hook原文，**没有完整GL shader正文**。不以额外GPU补档，也不改已跑driver。

## 性能复核（首轮保留）

理由：C13鸟瞰64.3571/p9515.5；首轮C14鸟瞰58.6267/p9530.8，所以获单次同源完整复核授权。复核未再出现该下降；这不能证明某个环境原因，更不能把首轮删除或称恒定wall成本。

| 段 | 首轮 FPS / p95ms | 首轮帧数 / >20ms数 / maxms | 复核 FPS / p95ms | 复核帧数 / >20ms数 / maxms |
|---|---:|---:|---:|---:|
| initial | 64.4713 / 15.5 | 975 / 8 / 30.9 | 65.0004 / 15.5 | 982 / 0 / 15.6 |
| station-street | 64.9995 / 15.5 | 203 / 0 / 15.6 | 64.9998 / 15.5 | 202 / 0 / 15.6 |
| station-port | 65.0019 / 15.5 | 202 / 0 / 15.6 | 64.9998 / 15.5 | 202 / 0 / 15.6 |
| island-aerial | 58.6267 / 30.8 | 184 / 20 / 30.9 | 64.9998 / 15.5 | 202 / 0 / 15.5 |
| shop-interior | 65.0019 / 15.5 | 202 / 0 / 15.6 | 64.9998 / 15.5 | 202 / 0 / 15.6 |
| walking-third | 64.9995 / 15.5 | 203 / 0 / 15.6 | 64.9995 / 15.5 | 203 / 0 / 15.6 |
| walking-first | 64.0389 / 15.5 | 200 / 3 / 30.8 | 64.9995 / 15.5 | 203 / 0 / 15.6 |

首轮长间隔约为两次65Hz显示间隔，不代表恒定58FPS成本。正常baseline不是隔离GPU微基准，含原全pass计数开销，动画继续；不归因wall shader、CPU审查或环境。CPU审查 city-result/audit 没有started/completed时间；首轮aerial阶段锚1794919452.601、下个shop锚1794919457.677包含准备/预热/采样/截图，无法精确建立CPU审查重叠，不用mtime代替。

三份source head一致；normal清单212项、fixed213项，唯一范围差是fixed另列 scripts/diagnose-wet-road.cjs；所有共有文件哈希相同，三清单各自对当前磁盘差异均0。

## 命令与冻结文件

Normal/repeat cwd：`D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/`

```text
node scripts/baseline.cjs --scene=combined --electron=D:/codex/2026-11-16/world-implementation/runtime-path-probe/electron.exe --stills --output=artifacts/gpu-town-c14
node scripts/baseline.cjs --scene=combined --electron=D:/codex/2026-11-16/world-implementation/runtime-path-probe/electron.exe --stills --output=artifacts/gpu-town-c14-repeat
```

定向：`node D:/codex/2026-11-16/world-implementation/handoff/x51-c14-diagnostic-gpu.cjs`

离线重放：`node D:/codex/2026-11-16/world-implementation/handoff/x51-c14-offline-analysis.cjs > D:/codex/2026-11-16/world-implementation/handoff/x51-c14-v1-numeric.json`，实际exit0；两驱动node --check exit0。已有FFmpeg只解码原PNG，未修改图片。完整每帧记录保持原artifact，numeric列七段framecount、所有>20ms帧索引/数值、max及samples SHA。

冻结：x51-c14-v1-analysis.json/.md、x51-c14-v1-numeric.json、x51-c14-offline-analysis.cjs；GPU driver x51-c14-diagnostic-gpu.cjs。analysis.evidenceHashes含原报告/清单/脚本/7组capture2PNG+JPG哈希。照片命名 `{view}-ao-on-capture-2`，七view同C13。原normal失败与clean定向分列，repeat不能覆盖首轮。
