# C14 只读 CPU 审查

源：7d362bc069b20c8e38fdf776c4eac5e87b0081ec。实际命令：`node D:/codex/2026-11-16/world-implementation/handoff/x51-c14-city-cpu.mjs`；exit 0。未改仓库，未运行 GPU。

- 未发现阻塞：捕获的父 paint 回调只调用一次，不递归；key 为 paint|town-wall-wash；缺 map chunk 明确抛错。实际 ShaderLib.toon 文本回调执行保留 paint=.06，插入一次 wash。此项不是 GPU 编译验证。
- 600 墙面三角，cast/receive 均 true；总 29553，严格小于 30000 尚可增加 446。位置、清除区域、道路/六阶元数据与 C13 完全相同。
- owned materials 29→30，几何 26 不变。两次 dispose：wall 一次、root 材质 25、root 几何 26；观察的借用纹理与原伞架探针均零释放。不冒称逐个验证全部 30 owned material。
- 保持同一 map、gradient、vMapUv 和采样 alpha；真实 canvas 由 textures.finish 标记 sRGB，r187 用 sRGB 格式上传。省掉的视频解码分支不适用于此静态 canvas。CPU 图片/画布为占位，未实测 GPU 色彩。
- 变换在线性光 RGB 上为 0.651+0.3s；0.93 为美术锚点，不是实测均值。基础顶点色与灯/AO/阴影算法未改，但 albedo 改动会影响最终亮度与暗部，不能表述全图/AO 像素不变。
- 必须继续由真实 GPU 判断视觉与编译；stderr 中占位纹理序列化及旧 mock 参数警告保留。详细范围、哈希在同名 JSON。
