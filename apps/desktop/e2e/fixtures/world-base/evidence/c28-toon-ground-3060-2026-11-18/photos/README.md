# 原始 C28 地面实拍与清晰度

原始候选 `880a02a762fd2d92f4c9c28c0c2bb5d6ac884157`。本目录保存傍晚 C28 默认、傍晚关闭新画风及午后关闭新画风。午后默认组进入 loading 后终止，没有原图。所有对照均沿用 C26、C27 的同一机位和固定场景时钟 14。

[傍晚 01 原生像素面板](native/evening-01-actual-pixels.png) · [傍晚默认无损全幅](native/evening-01-on-full.png) · [午后 01 原生像素面板，C28 列关闭新画风](native/afternoon-01-actual-pixels.png) · [午后关闭新画风无损全幅](native/afternoon-01-off-full.png)

面板中的招牌、窗框、樱冠和湿路都按来源 PNG 的整像素坐标直接粘贴，未缩放、锐化或重压。PNG 文件原始尺寸 1440 × 900，DPR、rendererPixelRatio 均为 1；CSS、canvas backing 与实际 GL drawingBuffer 均为 1440 × 900。浏览器默认 framebuffer 没有多重采样，sceneRT 与 compRT 则均为原分辨率、4× MSAA。默认动态模糊、光束、色散、扭曲均为零。傍晚 bloom 0.20，AO 0.55。

## 两个字区与街面

近处 E3 店檐能辨出「食料品」「日用雑貨」，字底同为偏紫的冷色，白字与底色之间的亮度差比中景拱门小。拱门能辨出「桜ヶ丘 駅前商店街」，字区的横向采样约 130 像素。E3 店檐「食料品」三个字的取样横跨度 50 像素。

| 原生字区/表面 | C26 傍晚开 P10–P90 | C27 傍晚开 | C28 傍晚开 | C28 午后关 |
|---|---:|---:|---:|---:|
| 拱门文字 [678, 353, 808, 377] | 76.6–204.7 | 81.4–209.7 | 82.0–209.7 | 65.5–165.9 |
| 檐字「食料品」 [1202, 366, 1252, 395] | 74.3–124.3 | 73.5–124.3 | 77.4–124.3 | 79.9–172.9 |
| 湿路与路标 [706, 646, 978, 800] | 73.8–92.7 | 73.8–92.7 | 73.8–92.7 | 74.8–95.0 |

P10、P90 为采样框中 sRGB 码值按亮度加权后的分位数，用于描述局部明暗差。晚间湿路的反光边界本身经过软化，三轮该区域几乎没有变化。右侧店檐在傍晚的字底明暗差约 47 级，午后关闭画风时约 93 级。傍晚窗格与栏杆保留硬边，樱冠内部仍有大片相近的粉紫色块。原始 C28 的增强线条没有解决这些面内的读字和明暗分离问题。

拱门由 src/streetscape.js 创建 1024×128 CanvasTexture，原绘制字框宽 864、高 88，使用三线性 mip 采样。E3 檐字由 shopsB/general.js 的 valanceTex 绘制于 1024×64 画布。固定像素 (1268,379) 的最近命中在 C28 开时为 E3 独立 1024×64 贴图，在关时为合批后的 4096² 图集。拱门中央像素的几何射线先打到遮挡剪贴片，本轮拱门源尺寸以实际生成器定义为据。

## 24 海报为什么移动

[24 海报原生同位置开关裁图](native/24-poster-actual-pixels.png) · [贴花索引、图格、站前局部位置与投影四角](native/24-poster-registration.json) · [两次同一份原生 PNG 图集](native/original-weathering-atlas.png)

开关两次图集均为 1024²，SHA-256 为 `4a5b4b075719328a726a13bda385ed7c7829b774c84194057a2209de12f08dd5`。关闭新画风时加载烘焙清单，画面右墙紫红星形海报为清单索引 15 / 图格 5，第一角投影为 (990.26,160.56)。开启时几何指纹变化，贴花系统重新规划，同一面墙改用索引 10 / 图格 4，第一角移至 (1172.99,253.40)。这是图案及空间位置同时改变。

同一 01 机位开启后的渲染统计为 2603 次调用，关闭时 1608 次。原始 C28 的 onBeforeCompile 包装器每次读取都生成新函数，使上游原有的严格函数引用合批检查失效。工作盘源代码与同机位实际图集、贴花指纹均支持这一诊断。该统计沿用角色画面捕获驱动的计数范围。

## 地面机位对照

[C26、C27、原始 C28 傍晚默认三列缩图](three-rounds-ground.jpg)。以下每个像素的差值取 RGB 三通道最大绝对差。

| 傍晚机位 | C26 默认 → C28 关改变像素 / 最大差 | C27 开 → C28 开超过 8 级像素 / 最大差 | 全分辨率 C28 |
|---|---:|---:|---|
| 23 维修角 | 0 / 0 | 149,329 / 197 | [关](images/evening-service-corner-off.jpg) · [开](images/evening-service-corner-on.jpg) |
| 24 洗衣店 | 0 / 0 | 185,628 / 203 | [关](images/evening-laundry-details-off.jpg) · [开](images/evening-laundry-details-on.jpg) |
| 04 朝内 | 0 / 0 | 54,538 / 123 | [关](images/evening-shop-interior-off.jpg) · [开](images/evening-shop-interior-on.jpg) |
| 20 后廊 | 0 / 0 | 85,784 / 198 | [关](images/evening-20-rear-eye-off.jpg) · [开](images/evening-20-rear-eye-on.jpg) |
| 21 正面 | 0 / 0 | 80,366 / 204 | [关](images/evening-21-front-eye-off.jpg) · [开](images/evening-21-front-eye-on.jpg) |
| 01 主街 | 0 / 0 | 166,093 / 179 | [关](images/evening-station-street-off.jpg) · [开](images/evening-station-street-on.jpg) |
| 沿街橱窗 | 0 / 0 | 79,621 / 166 | [关](images/evening-street-detail-off.jpg) · [开](images/evening-street-detail-on.jpg) |
| 04 朝门外 | 1 / 1 | 244,523 / 145 | [关](images/evening-shop-door-eye-off.jpg) · [开](images/evening-shop-door-eye-on.jpg) |
| 白车侧面 | 0 / 0 | 87,353 / 167 | [关](images/evening-van-side-off.jpg) · [开](images/evening-van-side-on.jpg) |

| 午后机位 | C26 默认 → C28 关改变像素 / 最大差 | C28 关 |
|---|---:|---|
| 01 主街 | 0 / 0 | [照片](images/afternoon-station-street-off.jpg) |
| 20 后廊 | 0 / 0 | [照片](images/afternoon-20-rear-eye-off.jpg) |
| 04 朝内 | 0 / 0 | [照片](images/afternoon-shop-interior-off.jpg) |
| 04 朝门外 | 0 / 0 | [照片](images/afternoon-shop-door-eye-off.jpg) |
| 白车侧面 | 0 / 0 | [照片](images/afternoon-van-side-off.jpg) |

首次傍晚默认启动与另一岛屿采集重叠，360 秒超时，无照片。再次启动傍晚默认，从页面加载至准备好定格耗时 250.83 秒；同机原始 C28 关闭新画风为 59.03 秒。最终三组完成渲染和现场还原，源文件、素材和八个实际加载的店铺模块检查通过；进程均因加载时有请求取消返回 1。精确帧时由独立的计时流程统计。

[固定相机、少量像素差、原生渲染尺寸与重复采样](measurements.json) · [字区坐标及亮度分位数](native/01-text-contrast.json)
