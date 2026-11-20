# C10 固定时间诊断 v1

源码 `53cb20a8c017eba04bc8dae1437a8179071a1b9d`；42张预定原图已保留。GPU已释放。

- `renderOk=true`；`transportClean=false` / exit1：menhir.glb、crate.gltf、crate.bin取消。源、driver、9asset未变，恢复完成。
- 店内 ROI x[270,430)、y[280,330) 仍有非单调带：y304平均红通道暗3.2125，y313暗6.1375，y322暗0.225。完整50行及原RGBA在报告；不能称全部横带消失或直接称合理接触。
- x350的13条几何射线：y273/277命中顶棚；y281..326命中同后墙x=-16.595、法线[1,0,0]。定位的是接收面，尚未确定每个AO采样遮挡物；独立station审计悬牌离墙1.278m，不能称贴墙。
- 灯箱21-front-eye实际3×3 ROI (519,323)均值约[252.22,247.78,233.56]，独立Basic，无clip，AO差≤1。laundry近景该点在y=-47，不采样。
- 顶灯中心(710,250)实际Basic+vertexColors白底；颜色已batch进顶点，所以工厂色匹配漏掉。固定ROI包含灯边，y250行平均暗约1级、核心y252差0，未复现此区域整体15级暗化。
- warm-lamp480tri=40盒，含既有2+新增38（增456tri）；灯箱12tri仅换材质；实际城市28857tri。
- 13/14重复帧相同，laundry-on仅2像素/2通道差1LSB，仍标严格整轮不一致。未测性能。

原始报告：`D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/artifacts/gpu-look-c10-v1/look-report.json`
完整分析：`D:/codex/2026-11-16/world-implementation/handoff/x51-c10-look-v1-analysis.json`
离线复现：`D:/codex/2026-11-16/world-implementation/handoff/x51-c10-look-offline-analysis.cjs`（实际CPU运行exit0，仅读PNG/报告）。
原driver：`D:/codex/2026-11-16/world-implementation/handoff/x51-c10-look-diagnostic-gpu.cjs`
旧证据与本轮v1文件冻结，不据后续实验改写。
