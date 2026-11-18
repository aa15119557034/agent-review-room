# C25 同机位复拍

RTX 3060 Laptop GPU，1440 × 900，DPR 1，AO 0.55，场景钟和站前钟固定在 14。C25 为 `a53236b3e4d5e3f0134f2fdd7629384171a64531`，C24 对照为 `4a8903840677d589f08e6a9934680b3b7b5f3d9c`。两轮均取原生 Electron 捕获的第二张正式 PNG。各组逐项核对了相机位置、四元数、FOV、灯光、场景参数、时钟、AO 和 GPU。原始 PNG 用于核算，下面的 JPEG 用于查看。[全部数值、相机及图像校验和](measurements.json)

## 七家店内

取 C24 相同的胶囊净空机位，视线朝店内，分别整场启动开、关、再开。C25 的七个机位后处理权重均为 0，开启时记录到 8 个店面保护盒。每幅图共 1,296,000 像素，差值按 RGB 三通道最大绝对差统计。局部坐标仅覆盖站位净空，本组没有测量穿门通行。

[七店放大对照，左 C24、中 C25 关、右 C25 开](seven-shops.jpg)

| 机位 | 店铺 | C24 开 → C25 开超过 8 级的像素 | C25 关 → 开改变像素 / 最大差 | C25 开 → 再开改变像素 / 最大差 | 全分辨率照片 |
|---|---|---:|---:|---:|---|
| W2 | 花店 | 1,223,661 | 0 / 0 | 0 / 0 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/shops-W2-on.jpg) · [关](images/shops-W2-off.jpg) · [开](images/shops-W2-on.jpg) · [再开](images/shops-W2-on-repeat.jpg) |
| W4 | 书店 | 998,790 | 0 / 0 | 0 / 0 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/shops-W4-on.jpg) · [关](images/shops-W4-off.jpg) · [开](images/shops-W4-on.jpg) · [再开](images/shops-W4-on-repeat.jpg) |
| W6 | 自行车店 | 1,294,626 | 0 / 0 | 0 / 0 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/shops-W6-on.jpg) · [关](images/shops-W6-off.jpg) · [开](images/shops-W6-on.jpg) · [再开](images/shops-W6-on-repeat.jpg) |
| E1 | 咖啡店 | 689,916 | 0 / 0 | 3 / 1 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/shops-E1-on.jpg) · [关](images/shops-E1-off.jpg) · [开](images/shops-E1-on.jpg) · [再开](images/shops-E1-on-repeat.jpg) |
| E2 | 和菓子店 | 1,146,593 | 1 / 1 | 0 / 0 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/shops-E2-on.jpg) · [关](images/shops-E2-off.jpg) · [开](images/shops-E2-on.jpg) · [再开](images/shops-E2-on-repeat.jpg) |
| E3 | 杂货店 | 1,188,030 | 0 / 0 | 0 / 0 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/shops-E3-on.jpg) · [关](images/shops-E3-off.jpg) · [开](images/shops-E3-on.jpg) · [再开](images/shops-E3-on-repeat.jpg) |
| E5 | 拉面店 | 1,245,764 | 0 / 0 | 0 / 0 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/shops-E5-on.jpg) · [关](images/shops-E5-off.jpg) · [开](images/shops-E5-on.jpg) · [再开](images/shops-E5-on-repeat.jpg) |

在 E1，首次开关逐像素相同，再开的三个单级差异集中在吧台酒架。E2 的单个差异位于画面底部的点心盒 (742, 886)，关为 RGB (145, 158, 163)，两次开均为 (145, 157, 163)。这一个绿通道差异在第二次开启时重复出现。完整像素坐标与 RGB 值记录在 measurements.json。

## 04 便利店与门外街面

朝内的 04 与朝外的 04 共用站位。朝外同一帧另取两块矩形，门框为 [680, 150, 730, 600)，门外街面为 [840, 600, 1080, 670)。坐标原点是左上，右界和下界取开区间。

| 时段 | 朝内整幅图关 → 开最大差 | 朝外门框 22,500 像素超过 8 级 / 最大差 | 朝外街面 16,800 像素超过 8 级 / 最大差 |
|---|---:|---:|---:|
| 傍晚 | 0 | 0 / 1 | 13,214 / 30 |
| 午后 | 0 | 0 / 1 | 3,339 / 31 |

[04 与店外橱窗的区域标注和跨版本差异图](doors-and-sidewalk.jpg) · [04 傍晚原图](images/evening-shop-door-eye-on.jpg) · [橱窗 C24 开](../../c24-shadow-tint-ground-3060-2026-11-18/images/evening-street-detail-on.jpg) · [橱窗 C25 开](images/evening-street-detail-on.jpg)

傍晚 04 向门外看，对面商店外立面 [1020, 240, 1080, 360) 的 7,200 像素中，C24 开 → C25 开有 6,027 个超过 8 级，C25 自身关 → 开在同区域最大差 1。01 主街右侧沿街立面 [1220, 175, 1340, 230) 也有 6,341 / 6,600 像素跨版本相差超过 8 级。

橱窗固定机位在店外，能看到外摆桌、长椅和铺地。两轮相机世界坐标均为 [284.4, 10.281286274509803, 924]，开时后处理权重从 1 降至 0.01274074。灰色铺地 [410, 725, 595, 790) 的 12,025 个像素在 C24 开 → C25 开时全部相差超过 8 级，平均 RGB 变化为 −13.7、−13.8、−26.4，最大差 27。C25 自身关 → 开时该区域最大差 1。固定机位的长椅区域 [965, 675, 1085, 700) 也有 3,000 / 3,000 像素跨版本相差超过 8 级。室内保护范围延伸到了玩家站立的店外铺地和沿街陈设。

## 地面机位与 20 后廊

[傍晚九机位对照](ground-evening.jpg) · [午后五机位对照](ground-afternoon.jpg)。每排依次为 C24 开、C25 关、C25 开。

| 时段与机位 | C25 关 → 开超过 8 级像素 / 最大差 | C24 开 → C25 开超过 8 级像素 / 最大差 | 全分辨率照片 |
|---|---:|---:|---|
| 傍晚 23 维修角 | 1,201,644 / 65 | 0 / 0 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/evening-service-corner-on.jpg) · [关](images/evening-service-corner-off.jpg) · [开](images/evening-service-corner-on.jpg) |
| 傍晚 24 洗衣细节 | 953,099 / 61 | 0 / 1 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/evening-laundry-details-on.jpg) · [关](images/evening-laundry-details-off.jpg) · [开](images/evening-laundry-details-on.jpg) |
| 傍晚 04 朝内 | 0 / 0 | 0 / 0 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/evening-shop-interior-on.jpg) · [关](images/evening-shop-interior-off.jpg) · [开](images/evening-shop-interior-on.jpg) |
| 傍晚 20 后廊 | 521,682 / 64 | 0 / 0 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/evening-20-rear-eye-on.jpg) · [关](images/evening-20-rear-eye-off.jpg) · [开](images/evening-20-rear-eye-on.jpg) |
| 傍晚 21 正面 | 512,205 / 62 | 0 / 0 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/evening-21-front-eye-on.jpg) · [关](images/evening-21-front-eye-off.jpg) · [开](images/evening-21-front-eye-on.jpg) |
| 傍晚 01 主街 | 842,068 / 59 | 231,242 / 53 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/evening-station-street-on.jpg) · [关](images/evening-station-street-off.jpg) · [开](images/evening-station-street-on.jpg) |
| 傍晚 橱窗 | 29,218 / 45 | 1,081,657 / 54 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/evening-street-detail-on.jpg) · [关](images/evening-street-detail-off.jpg) · [开](images/evening-street-detail-on.jpg) |
| 傍晚 04 朝门外 | 322,310 / 49 | 120,652 / 44 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/evening-shop-door-eye-on.jpg) · [关](images/evening-shop-door-eye-off.jpg) · [开](images/evening-shop-door-eye-on.jpg) |
| 傍晚 车侧 | 962,651 / 63 | 0 / 0 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/evening-van-side-on.jpg) · [关](images/evening-van-side-off.jpg) · [开](images/evening-van-side-on.jpg) |
| 午后 01 主街 | 835,422 / 71 | 157,536 / 56 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/afternoon-station-street-on.jpg) · [关](images/afternoon-station-street-off.jpg) · [开](images/afternoon-station-street-on.jpg) |
| 午后 20 后廊 | 262,895 / 58 | 0 / 0 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/afternoon-20-rear-eye-on.jpg) · [关](images/afternoon-20-rear-eye-off.jpg) · [开](images/afternoon-20-rear-eye-on.jpg) |
| 午后 04 朝内 | 0 / 0 | 0 / 0 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/afternoon-shop-interior-on.jpg) · [关](images/afternoon-shop-interior-off.jpg) · [开](images/afternoon-shop-interior-on.jpg) |
| 午后 04 朝门外 | 162,069 / 44 | 85,824 / 40 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/afternoon-shop-door-eye-on.jpg) · [关](images/afternoon-shop-door-eye-off.jpg) · [开](images/afternoon-shop-door-eye-on.jpg) |
| 午后 车侧 | 863,245 / 56 | 0 / 1 | [上轮开](../../c24-shadow-tint-ground-3060-2026-11-18/images/afternoon-van-side-on.jpg) · [关](images/afternoon-van-side-off.jpg) · [开](images/afternoon-van-side-on.jpg) |

20 沿用前轮后墙 [970, 495, 1015, 540) 与门扇 [1048, 473, 1083, 520) 两个区域。亮度为 sRGB 码值折算的加权平均。

| 时段 | 区域 | C25 关 → 开平均亮度 | C24 开 → C25 开平均亮度 | C24 开 → C25 开最大差 |
|---|---|---:|---:|---:|
| 傍晚 | 后墙 | 43.25 → 51.69 | 51.69 → 51.69 | 0 |
| 傍晚 | 门 | 96.14 → 115.18 | 115.18 → 115.18 | 0 |
| 午后 | 后墙 | 78.30 → 80.38 | 80.38 → 80.38 | 0 |
| 午后 | 门 | 183.63 → 183.63 | 183.63 → 183.63 | 0 |

## 捕获状态

每个机位顺序捕获预热、第一张、第二张，以下统计只用第二张。各组均到达 complete，渲染正常，源文件、素材、采集驱动和现场还原校验通过，渲染异常和 HTTP 错误均为零。进程退出码和加载时取消的请求按组保留。

| 组 | 捕获张数 | 退出码 | 加载时取消的资源 |
|---|---:|---:|---|
| shops-on | 21 | 1 | plastic_crate_02_1k.gltf (net::ERR_ABORTED), plastic_crate_02.bin (net::ERR_ABORTED) |
| shops-off | 21 | 0 | 无 |
| shops-on-repeat | 21 | 1 | plastic_crate_02_1k.gltf (net::ERR_ABORTED), plastic_crate_02.bin (net::ERR_ABORTED) |
| evening-on | 27 | 1 | plastic_crate_02_1k.gltf (net::ERR_ABORTED) |
| evening-off | 27 | 1 | menhir.glb (net::ERR_ABORTED), plastic_crate_02_1k.gltf (net::ERR_ABORTED) |
| afternoon-on | 15 | 1 | plastic_crate_02_1k.gltf (net::ERR_ABORTED), plastic_crate_02.bin (net::ERR_ABORTED) |
| afternoon-off | 15 | 1 | plastic_crate_02_1k.gltf (net::ERR_ABORTED) |
