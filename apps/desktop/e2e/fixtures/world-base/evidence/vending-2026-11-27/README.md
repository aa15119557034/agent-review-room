# X-51 · 贩卖机与小道具

傍晚与夜间在 ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU (0x00002520) Direct3D11 vs_5_0 ps_5_0, D3D11) 上用 Electron 冻结时钟实拍，分辨率为 1440×900。页面与场景错误、WebGL 错误和尺寸警告均为零。抽样机器位于 `larkhaven:crown`。三个镇上候选的种类、摆位和朝向在两版中逐项一致。W1 的 V3a、V3b 和原回收箱采用同一组现场摆位和原有碰撞体。投光保留 7 处地面及 1 处实际墙面接收区域，共 1190 个三角面，合为一次加色绘制。地面在拼接边缘渐隐。 [同机位与场景记录](checks.json)

- A 主街三列对照。[傍晚](A-main-street-evening.jpg) · [夜间](A-main-street-night.jpg)
- 镇上抽样三列对照。[傍晚](town-evening.jpg) · [夜间](town-night.jpg)
- W1 门口近景展示商品窗和地面投光。[傍晚](W1-evening.jpg) · [夜间](W1-night.jpg)
- 停止牌「止まれ」、有深度的两个回收投入口和分类标签。[道具近照](small-props.jpg)

街景参考来自交接的第 3、6、10 张图，用于对照街景构图、综合色和光落到路面的范围。商品窗照明也参考日本常见的 LED 商品陈列窗。[日本可口可乐商品窗照明说明](https://www.coca-cola.com/jp/ja/media-center/energy-saving)

两组夜间照片使用相同的夜间环境参数。Blender 5.2.2 重导两种商品窗口、停止牌和回收箱，退出 0。夜间使用 `?time=night`，傍晚使用 `?time=evening`。`?vendlight=off` 单独关闭这轮机窗发光与近处投光。新场景按实际布局离线重烘贴花。原生和加速离线烘焙逐字节一致。
