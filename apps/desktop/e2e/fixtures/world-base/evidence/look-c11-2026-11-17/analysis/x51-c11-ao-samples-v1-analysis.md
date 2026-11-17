# C11 实际 GPU AO 回归

C10已定位的店内顶棚次峰在本ROI/六点回归闭环；不扩大为全场景AO正确性证明。

源e1f32af2cfcde2e1e958a0dffb87f8d219886d5c。PID65120/session89647，实际exit1（menhir.glb/crate.gltf取消）；renderOk=true，source/driver/9asset未变，恢复完成，GPU已释放。

直接绑定真实1440×900深度，活动wbDepth/wbPos/wbNormal/wbAO原函数，16×60 RGBA32F读回96tap×10字段。新分项完整记录rise/angleGate/heightGate/up/h/frontGate/planeNearWeight/near/rangeWeight/1.4，未混C10旧项。原wbAO与新分项和最大误差2.756714812e-8，GL error0。

| x350 / y | C10 GPU AO | C11 GPU AO |
|---|---:|---:|
| 285 | 0.683667898 | 0.576299727 |
| 289 | 0.680174232 | 0.690396786 |
| 295 | 0.788272977 | 0.797477007 |
| 304 | 0.939604342 | 0.915959418 |
| 313 | 0.885747731 | 0.962688088 |
| 322 | 0.994971395 | 1.000000000 |

## 原次峰两tap

| y / tap | rise | h | angle/height gate | near | L | rangeWeight | contribution |
|---|---:|---:|---|---:|---:|---:|---:|
| 304/3 | 0.664185 | 0.244623 | 1/1 | 0.485554 | 0.883680 | 1 | 0.485554 |
| 304/5 | 0.964799 | 0.248032 | 1/1 | 0.474910 | 1.061307 | 1 | 0.474910 |
| 313/3 | 0.163337 | 0.335386 | 1/1 | 0.217613 | 0.490173 | 1 | 0.217613 |
| 313/5 | 0.504153 | 0.338755 | 1/1 | 0.208809 | 0.626393 | 1 | 0.208809 |

两tap在旧次峰y304→313时h从约.245/.248m增至.335/.339m，near从.486/.475降至.218/.209；rangeWeight都1，故旧欧氏距离衰减反升已不驱动次峰。这里只确认实际受测回归，不替C断言整个AO不存在其他边界情况。

原GPU字段及shader：`D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/artifacts/gpu-ao-c11-samples-v1/gpu-ao-samples.json`；报告`look-report.json`。
详细分析：`D:/codex/2026-11-16/world-implementation/handoff/x51-c11-ao-samples-v1-analysis.json`。
driver：`D:/codex/2026-11-16/world-implementation/handoff/x51-c11-ao-samples-gpu.cjs`；离线复现：`D:/codex/2026-11-16/world-implementation/handoff/x51-c11-ao-samples-offline-analysis.cjs`（syntax与实际CPU执行exit0）。
几何射线只做nearest texel旁证，不替代真实GPU depth；无性能测试、无fixture写入、无重跑取绿。
