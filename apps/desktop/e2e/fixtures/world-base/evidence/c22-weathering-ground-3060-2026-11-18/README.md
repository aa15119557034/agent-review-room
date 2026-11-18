# 第 22 轮墙面做旧 · 常规游玩视角实测

C酱源码 `3739b43`，本机检出 `7a36abd`。

同机 RTX 3060 Laptop、D3D11、1440 × 900、DPR 1。傍晚和下午都用原生查询参数切换做旧。拍照时将车站和岛屿时钟固定在 14，对照双方的机位、FOV、AO、灯光和后期参数逐一相同。四种公寓材质都读到了本机准备的 1024 × 1024 漫反射贴图。

## 实拍与画面问题

01 左侧荧绿色海报的下半幅跨过花箱上沿。配置将这张 0.55 米宽的海报放在墙面局部 x = −4.84 米，实际中心落到 x = −4.49 米，向街面偏了 0.35 米。手摆海报只吸附中心点，自动摆放使用的九点同平面检查没有应用到这张海报。从主街视角能看到海报盖在花和箱体前面。

[![01 左侧花箱局部，左关右开](crops/station-street.png)](crops/station-street.png)

白色面包车的前翼子板和车门出现沿三角面分界的硬色块。原尺寸车门漆面取样区域为 x 452–647、y 474–526，10,388 个像素中有 9,484 个在开关间发生变化，最大通道差 10。

[![白色面包车漆面局部，左关右开](crops/van-side.png)](crops/van-side.png)

20 后廊仍看得出栏杆、门和墙面的明暗关系。21 信箱上方的海报落在完整墙面。24 的海报在贴墙近景中靠近画框边缘。下午复拍也能看到同一处花箱海报和车身色块。当前真实抹灰纹理上的新雨痕较弱，从全效果开关对照中不易单独分辨。

| 机位 | 做旧关 | 做旧开 |
|---|---|---|
| 01 站前主街 | [![01 站前主街 关](images/evening-01-off.jpg)](images/evening-01-off.jpg) | [![01 站前主街 开](images/evening-01-on.jpg)](images/evening-01-on.jpg) |
| 20 公寓后廊 | [![20 公寓后廊 关](images/evening-20-off.jpg)](images/evening-20-off.jpg) | [![20 公寓后廊 开](images/evening-20-on.jpg)](images/evening-20-on.jpg) |
| 21 洗衣店前 | [![21 洗衣店前 关](images/evening-21-off.jpg)](images/evening-21-off.jpg) | [![21 洗衣店前 开](images/evening-21-on.jpg)](images/evening-21-on.jpg) |
| 24 洗衣店细节 | [![24 洗衣店细节 关](images/evening-24-off.jpg)](images/evening-24-off.jpg) | [![24 洗衣店细节 开](images/evening-24-on.jpg)](images/evening-24-on.jpg) |
| 白色面包车 | [![白色面包车 关](images/evening-van-off.jpg)](images/evening-van-off.jpg) | [![白色面包车 开](images/evening-van-on.jpg)](images/evening-van-on.jpg) |
| 23 维修角 | [![23 维修角 关](images/evening-23-off.jpg)](images/evening-23-off.jpg) | [![23 维修角 开](images/evening-23-on.jpg)](images/evening-23-on.jpg) |
| 04 便利店内 | [![04 便利店内 关](images/evening-04-off.jpg)](images/evening-04-off.jpg) | [![04 便利店内 开](images/evening-04-on.jpg)](images/evening-04-on.jpg) |
| 商店橱窗近景 | [![商店橱窗近景 关](images/evening-detail-off.jpg)](images/evening-detail-off.jpg) | [![商店橱窗近景 开](images/evening-detail-on.jpg)](images/evening-detail-on.jpg) |

### 下午同机位

| 机位 | 做旧关 | 做旧开 |
|---|---|---|
| 01 站前主街 | [![01 站前主街 关](images/afternoon-01-off.jpg)](images/afternoon-01-off.jpg) | [![01 站前主街 开](images/afternoon-01-on.jpg)](images/afternoon-01-on.jpg) |
| 20 公寓后廊 | [![20 公寓后廊 关](images/afternoon-20-off.jpg)](images/afternoon-20-off.jpg) | [![20 公寓后廊 开](images/afternoon-20-on.jpg)](images/afternoon-20-on.jpg) |
| 白色面包车 | [![白色面包车 关](images/afternoon-van-off.jpg)](images/afternoon-van-off.jpg) | [![白色面包车 开](images/afternoon-van-on.jpg)](images/afternoon-van-on.jpg) |

## 进场耗时

| 同机地面采样 | 首个就绪帧，秒 | 安放站后建筑到场景就绪，秒 |
|---|---:|---:|
| C21 地面首测 | 39.67 | 0.26 |
| C21 地面复测 | 39.99 | 0.22 |
| 做旧开 | 103.02 | 65.50 |
| 做旧关 | 105.84 | 68.69 |
| 再次开启 | 102.43 | 65.05 |

独立的下午启动 CPU 采样覆盖 103.89 秒。落在贴花放置调用栈中的采样约 65.58 秒，其中表面命中查询约 65.57 秒。材质做旧调用栈约 0.11 秒。子调用时间包含在上层，首帧耗时取自未开 CPU 采样的傍晚进程。当前共有 26 张静态贴花。下一版可优先缩小射线查询的候选墙面，或预计算确认过的贴花位置。

[未采样的首帧时间及 CPU 统计](startup.json) · [原始 CPU 采样](startup.cpuprofile.json.gz)

## 地面帧时

三轮按开启、关闭、再次开启顺序采样，分别有 7/8、6/8、6/8 段达标。20、21、23、24 的 p95 三轮均为 15.5 ms。01 主街的 p95 依次为 30.8 / 15.5 / 30.7 ms。关闭做旧时两种步行仍出现长帧，上一版 C21 的纯地面复测也有同类波动。这组三轮切换整套做旧，雨痕采样和棱边着色各自的帧时收益仍待单项复核。

| 机位或路线 | 做旧开 FPS / p95 ms | 做旧关 FPS / p95 ms | 再次开启 FPS / p95 ms | 三轮 >20 ms 帧数 |
|---|---:|---:|---:|---:|
| 01 站前主街 | 59.58 / 30.8 | 64.05 / 15.5 | 60.86 / 30.7 | 17 / 3 / 13 |
| 04 便利店内 | 65.00 / 15.5 | 65.00 / 15.5 | 65.00 / 15.5 | 0 / 0 / 0 |
| 20 公寓后廊 | 65.00 / 15.5 | 65.00 / 15.5 | 64.80 / 15.5 | 0 / 0 / 2 |
| 21 洗衣店前 | 65.00 / 15.5 | 65.00 / 15.5 | 65.00 / 15.5 | 0 / 0 / 0 |
| 23 维修角 | 65.00 / 15.5 | 65.00 / 15.5 | 65.00 / 15.5 | 0 / 0 / 0 |
| 24 洗衣店细节 | 65.00 / 15.5 | 65.00 / 15.5 | 65.00 / 15.5 | 0 / 0 / 0 |
| 第三人称步行 | 63.72 / 15.5 | 51.49 / 30.8 | 57.67 / 30.8 | 4 / 42 / 23 |
| 第一人称步行 | 64.68 / 15.5 | 60.20 / 30.8 | 62.12 / 15.5 | 1 / 15 / 9 |

主街、店内、两个步行段各采 3 秒，四个镇边机位各采 10 秒，步行使用真实 W 键输入。达标线为平均 ≥ 60 FPS 且 p95 ≤ 16.7 ms。表内 p95 由原始帧间隔按最近秩统一重算。共 10,198 帧。做旧关闭时仍会完成材质与贴花初始化，再将着色强度归零并隐藏贴花。

四个拍照进程和六个计时进程均完成渲染，合计 0 个 JS 异常。1 个进程退出 0，其余退出码、资源取消和分段预算见记录。合入源码的 Windows CI 已跑过 `node scripts/verify.mjs`。 [Windows CI](https://github.com/aa15119557034/agent-review-room/actions/runs/44213526572/job/134497541293)

[逐段帧时、绘制量和进程状态](frame-times.json) · [三轮 24 段原始帧](frames.json.gz) · [相机、照片校验和真实贴图](photos.json) · [C酱源码交回](https://github.com/aa15119557034/agent-review-room/pull/254#issuecomment-6965748844) · [C21 地面基线](https://github.com/aa15119557034/agent-review-room/pull/254#issuecomment-6965240503)

可在已准备本机素材的检出上复做地面计时。命令为 `node driver/ground.cjs <fixture> <electron.exe> <此目录的 frame-times.json> <新输出目录> on`，最后一项也可传 `off`。
