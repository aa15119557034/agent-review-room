# X-51 自渲染素材证据索引

所有图均为本机独立viewer自渲染，没有复制官方预览。原模型/材质基线与适配克隆明确分开；不涉及fixture修改，也不代表场景效果或FPS验收。

1. [三资产原始预览](README.md)：crate原导出存在近侧壁遮挡问题；bench实拍造型偏复古；shutter细节可读。
2. [crate仅改不透明的假设验证](crate-opaque-ab/README.md)：近侧壁恢复，但黑栅格不是已验证的几何孔。
3. [crate补回作者opacity的最终对照](crate-mask-ab/README.md)：完整壁面与cutout并存，阴影也随镂空改变；这是本轮最终素材对照。
4. [来源、许可、原13文件与补充mask哈希](source-provenance.json)。素材资产来自Poly Haven，CC0；官方网页/预览许可与资产许可没有混同。

根层已作取舍：bench的复古卷边造型不用于当前现代日式街道示范区；shutter保留。crate的最终取舍与场景接入仍由根层决定。

分享时请保持 `preview-output/` 与 `supplemental/` 为相邻目录，文中链接均用相对路径。所有运行已退出，本轮GPU进程/窗口已关闭。每轮report和历史失败记录未覆盖；最初 `preview-file-sha256.json` 是初次预览源版本快照，后续viewer变化的hash记录在最终masked对照的comparison-check中。
