# 本机独立素材预览

本轮最终 Electron 进程退出码 0，临时 BrowserWindow 已由 finally 销毁，HTTP server 已关闭，未留下运行中的预览进程。未改 fixture、原 glTF/BIN/JPG 或原模型材质；13 个源文件渲染前后 SHA256 完全一致。

## 输出

| 素材 | 原图 | 960px 预览 |
|---|---|---|
| Plastic Crate 02 | [01-plastic_crate_02.png](01-plastic_crate_02.png) | [01-plastic_crate_02.jpg](01-plastic_crate_02.jpg) |
| Painted Wooden Bench | [02-painted_wooden_bench.png](02-painted_wooden_bench.png) | [02-painted_wooden_bench.jpg](02-painted_wooden_bench.jpg) |
| Worn Shutter 材质平面 | [03-worn_shutter.png](03-worn_shutter.png) | [03-worn_shutter.jpg](03-worn_shutter.jpg) |

PNG 均1440×900；JPG均960×600。`preview-report.json` 保存相机、光照、渲染器、载入后材质参数、20个实际请求、异常、原文件前后哈希。`preview-file-sha256.json` 保存预览图与本地viewer源文件的哈希。

## 实际运行

- 固定 Three **r187** 与 vendored GLTFLoader；已有 Electron：`D:/codex/2026-11-16/world-implementation/runtime-path-probe/electron.exe`。
- WebGL2，ANGLE / NVIDIA GeForce RTX 3060 Laptop GPU / D3D11；最终20请求全200，renderer error=0，contextLost=false，exceptions=[]。
- 中性灰背景/地面、白色方向光、半球光、仅预览用的灰度环境贴图；ACESFilmic、曝光1。环境图由viewer本地64×32灰阶数据生成后PMREM，不是下载的HDRI或资产修改。
- 两模型只做极小落地平移（抵消负 minY），没有缩放；增加cast/receiveShadow对象标记，没有覆写材质。原始 glTF 的 BLEND、doubleSided、baseColorFactor 和缺省AO均保留。
- shutter本来仅选了纹理：此图用1.37m正方平面作展示载体，明确不冒充原作者完整卷帘门模型。颜色sRGB，GL法线及ARM为数据，ARM分别接AO/roughness/metalness；无位移或几何细分。
- 两glTF缺TANGENT，固定GLTFLoader在其 `useDerivativeTangents` 分支会将 `normalScale.y` 乘-1（源码3645行），因此日志为[1,-1]；这是loader自己的坐标处理，viewer没有额外翻绿通道。手建shutter平面按TextureLoader/PlaneGeometry的普通UV路径使用GL图和[1,1]，没有套用glTF的额外修正。
- 有一条兼容警告：r187已移除PCFSoftShadowMap，自动使用PCFShadowMap。图片使用的是实际回退后的PCF；没有声称console零警告，也没有为消除该提示重复调光重拍。

## 已查看实际像素后的判断

1. **Crate不可直接当作合格资产入场。** 当前原导出预览能看到近侧箱壁大面积缺失/穿透；运行材质确认 `transparent=true, opacity=1, depthWrite=false, side=FrontSide`，与原glTF `BLEND` 一致。缺失的确切几何/排序原因尚未做独立A/B，所以这里只记录实际问题，不宣称已证明某一个修复。原始JPEG无alpha的CPU发现仍成立。没有为了“好看”把它改成Opaque或双面。
2. **Bench纹理有效，但造型偏复古。** 实拍是背板+卷边侧扶手的深红旧木凳，有明显磨损/木纹，并非普通日式街边长椅。是否采用由root根据场景取舍；低面数不等于风格通过。
3. **Shutter细节确实可读，但整体很深。** 凹槽、污积和擦痕在此中性预览可见；放到店面后与周边toon材质的关系尚未验收。没有加bloom、抬全局曝光或改作者颜色图掩盖深色。

这些是**独立素材预览**，不是站区/镇边两块示范区验收，也不是人眼1.6m场景镜头，更不能据这次运行汇报FPS。

## 首次失败记录

`attempt-01-init-report.json` 保留首次失败：固定vendor目录没有RoomEnvironment.js，请求404，初始化超时。未安装或下载组件；随后去掉这个依赖，改用上面的本地中性灰环境。最终报告没有这个404，原资产哈希始终未变。
