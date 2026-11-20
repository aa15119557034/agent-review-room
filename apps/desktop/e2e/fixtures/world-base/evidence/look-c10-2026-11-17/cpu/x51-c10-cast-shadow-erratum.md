# C10 灯具投影勘误

原 `x51-c10-readonly-audit.md/json` 中“shadow:false只关闭投影”表述只反映构建参数的意图，**未反映最终运行时状态，此处纠正**。原始报告保留，不静默覆盖。

`src/city-apartments.js` 给新灯和灯箱传入 `shadow:false`，但 `src/city.js:189` 的末尾遍历无条件设置 `object.castShadow = true`（以及 `receiveShadow = true`），覆盖了合批对象原先的标志。`diagnostic/look-report.json.gz` 的 `initial.lightMaterials` 与各条 record 也确认 warm-lamp 和独立 white-sign 两批实际 `castShadow=true`。因此不能说本轮新灯已经实现“不投影”。

这与“没有新增 Three Light”是两回事：Basic自亮面没有照亮周围的实时光源，但几何仍参与已有太阳阴影图。全屏AO是否压灯又是另一条路径，不能靠castShadow开关解决。

下一棒请在city最终投影策略层保留这些明确不投影灯面的标志，同时保住墙、楼梯、阳台投影；本轮只回报与勘误，没有修改运行源码或声称修复完成。
