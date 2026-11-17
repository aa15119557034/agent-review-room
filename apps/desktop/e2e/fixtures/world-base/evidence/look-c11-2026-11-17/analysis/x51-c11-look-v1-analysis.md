# C11 本机固定时间诊断

结论：C10已定位的店内次峰在本ROI/六点回归闭环；当前20/21机位未见主结构阴影明显回退。不能扩成整个AO/整个场景最终验收。

源码e1f32af2cfcde2e1e958a0dffb87f8d219886d5c。PID60388/session59416实际exit1；renderOk=true，transportClean=false（crate.gltf/bin取消）。原42+独立shadow18全部保留；source/driver/9assets未变，临时flags已恢复。

## 店内与暗部

1440×900左上原点，后墙x[270,430)、y[280,330)。红通道off−on：y28524.04375→28917.325→29511.25625→3044.5→3131.975→3220。未要求全图逐像素平滑；原尺寸on/off肉眼已明显改善。
两处旧服务角HDR ROI与C8/C10的scene/comp半浮点字一致；最终点(763,369)on/off均[26,31,42]，(762,459)均[26,31,41]，暗部toe保持。白灯箱(519,323,3,3)均值约[252.4444,248,233.7778]，AO差0。店内灯条(710,250)实际Basic+vertexColors，采样行暗约[1.0583,1.6,1.1417]；ROI含边缘，不代表整灯。

## 城市阴影实录与独立ABA

实际32mesh：CR Toon23/Standard1；cR Toon4/Shader2/Basic2。全部有稳定position/index等字节SHA、material/transform签名，不用随机UUID作跨运行identity。
4非cast Toon：796tri基础+全部6组连接阶+杆身；564tri压顶/横担/绝缘子/导线；708tri两道路；565tri植栽/盆花。名称来自station CPU建造栈，按唯一tri/type/worldBounds与GPU匹配；CPU未保存属性字节hash，不冒称CPU几何逐字一致。
20/21仅临时将这4个Toon bin cast=true，灯/玻璃仍false，AO.55/time14不变，刷新shadowmap。以下均为1440×900完整PNG：

| 机位 | 改变像素 | meanAbsRGB | maxAbsRGB | 恢复A差异 |
|---|---:|---:|---:|---:|
| 20-rear-eye | 737 | 0.0011268004115226337 | 17 | 0 |
| 21-front-eye | 62 | 0.00025385802469135804 | 35 | 0 |

两次A均PNG字节相同，且与原42图默认AO-on一致。当前机位主墙/阳台/背部钢梯投影清楚；**6组连接阶实际仍cast=false**，不能说所有楼梯投影都保住。临时恢复4bin仅诊断，没有进产品。
C10→C11 AO-off对比相机/time/params一致，只有源look/city两文件变化；20/21改变6595/1272像素，包含灯/玻璃策略改变，不能把该跨版本差全部算到4Toon。
C10只留下两灯批实际flags，均true→本轮false；其余旧全城true/true为旧统一遍历源码推导，非旧GPU逐mesh录制。

文件：`D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/artifacts/gpu-look-c11-v1/look-report.json`、`city-shadow-audit.json`。shadow图片前缀：`shadow-{20-rear-eye,21-front-eye}-{original,diagnostic-four-toon-on,restored}-capture-2`，PNG/JPG均有。
原driver：`D:/codex/2026-11-16/world-implementation/handoff/x51-c11-look-diagnostic-gpu.cjs`；离线：`D:/codex/2026-11-16/world-implementation/handoff/x51-c11-look-offline-analysis.cjs`（syntax和CPU执行均exit0）。
未测性能、不重试取绿、无fixture/Git修改；GPU已释放。
