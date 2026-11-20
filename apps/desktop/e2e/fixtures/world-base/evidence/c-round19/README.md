# C酱 第 19 轮：傍晚光照（#254）

每张图左 = `?time=afternoon`（Petalwake 原下午光照），右 = 默认傍晚。
云端 Chromium + SwiftShader，960×600，像素比 1；Poly Haven 贴图在云端连不上，用的是同尺寸替身（公寓墙面、道具），墙面颜色以林离本机真实 PBR 为准。帧时不在云端测。

- 太阳：高 12°、方位 280°（原 34°/218°），`src/evening.json`。
- 地形太阳阴影：`scripts/bake-evening-light.py` 用 Petalwake 自己的 `bake_shadow` / `stamp_shadows` 重烘 R 通道，生成 `.local/.../light-evening.png`（不进 git）。
- 天空 / 雾 / 环境光：`ENV.evening`；DirectionalLight `#ffc490 ×2.3`，HemisphereLight `#a8b4ec / #8a6e5c ×0.95`。
- 发光：`src/evening-glow.js` 把无贴图、本身就亮的 MeshBasic（路灯、灯箱、门灯、车灯、远景窗）推到 HDR ×2.1，招牌印刷 ×1.25，bloom 0.12→0.2。
- 叶片卡：按采样的 mip 级补 alpha（`town-plants.js`），远处不再整片透空。

已知：樱花被直射的一面仍偏橙红；港镇自带屋顶阴影和 `src/street-env/` 倒影还是下午方向；04 店内与下午基本一致。
