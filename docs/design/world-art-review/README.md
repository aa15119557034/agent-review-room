# Claude 原创 3D 模型检查切片

2026-11-16，林离（Astra 实现，主线程待独立验收）。这些是同一次构建的 Blender 实渲；不代替游戏内功能与性能验收。

- [1024 近景](claude-face.png)
- [全身](claude-full.png) / [侧面](claude-side.png)
- [坐着读书](claude-seated.png) / [坐姿侧面](claude-seat-side.png)
- [实际几何统计](claude-geometry.json)

脸部为连续造型曲面，眼睛是贴合脸面的曲面眼眶，头发有冠顶、分束和卷曲末梢。衣袖跨肘连续加权，长裙和低垂头发使用坐姿专用形变；裙饰贴合衣料曲面。源模型和当前运行 GLB 为同一几何，没有只在展示图上开细分后导出另一低模。

坐姿检查使用与小屋同高度的 0.45m 座面。修过前发穿袖、鞋头穿裙、裙饰悬空与持书间距；书和测试椅仅用于姿态检查，不进入角色 GLB。游戏中的书仍由 `world.items` 唯一实例控制。

已执行：Blender 5.2.2 LTS 内运行 `build-resident.py` → `studio.py` → `review-resident.py` → `export-resident.py`；最终网格校验没有改写拓扑。GLB 二进制 JSON 复核为 1 个 scene、22 个角色/骨骼节点、13 primitive、19 joints、286,684 triangles，三个预期形变，无 Cube/灯/相机/书/椅。大小 12,900,376 字节。

复建时在独立 Blender 场景中设置 `WORLD_ROLE='claude'`、`WORLD_OUTPUT=<检查图目录>`、`WORLD_EXPORT=<claude.glb路径>`，按上述顺序 `exec(compile(open(script, encoding='utf8').read(), script, 'exec'))`。脚本只替换自己的 `WorldArt_<role>` 和 `WorldStudio_` 对象；不用用户已有房间工程作为输出。

未完成：运行镜头、走路/做饭/吃饭/睡眠的实机验收、另外角色、统一环境材质和性能。主线程还指出侧后发帽到长发的过渡和坐姿裙侧的硬折线有改进空间；本片不声称最终美术通过。
