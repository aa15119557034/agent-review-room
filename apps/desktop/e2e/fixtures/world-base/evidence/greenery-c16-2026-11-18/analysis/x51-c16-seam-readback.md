# C16 实际接缝材质与画面

source50e190b，fixed session67606/PID61484，actualexit1；renderOktrue，menhir+crate.bin取消，0JS异常。原21图+town30图=51；source/driver/9assets/restore全true，townrect/strength已恢复，GPU释放。

实际查看north-seam-central/oblique的A1/B截图：两候选均无遮挡，开启town时有明显亮绿细带，关闭时细带与前景的色差大幅消退。保存A2用于root离线恢复比较，未挑帧/换机位。

actual town-material-audit：terrain有TOWN；transition与env-terrain-ground/levee-island-blend均没有TOWN定义，两个town uniforms为null；111个shell材质均有定义且与terrain共享uniform对象。5个已使用GL program均编译/链接成功。原shader/实际GL完整正文与SHA是独立字段，未覆盖。

两条缝位于townMask核心，不是外部55m过渡。这支持补丁未传到接缝材质导致颜色不连续；不把几何ray单独当fragment来源证明。town0仅关闭岛屿草花/terrain，cityfoliage与gravel仍C16。单场景稳定计数不能证明跨create/dispose无泄漏。数值与ABA逐像素恢复由root离线分析，不在此重复。

完整路径与SHA见x51-c16-targeted-execution.json、x51-c16-seam-readback.json；raw在fixture/artifacts/gpu-look-c16-v1。
