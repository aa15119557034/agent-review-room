# C15 保守立面第一轮 — 实现与 CPU 交接

已冻结 `src/city.js`、`src/city-apartments.js`；保留 station_adapter 的516 tri隐面修改。本轮未改其他 fixture 源、upstream、manifest，没有 GPU/Git 写/GitHub 操作。

## 实际结果

- 隐面后29,037 + 立面896 = **29,933 tri**；严格 `<30000`，还能加66而不是67。3F未增加生活物；4F新增540、5F336、招牌/贴纸/A-frame共20。
- 新9AC、3简管/檐沟、2壁挂衣杆（4件衣，全部衣物12）、3窄金属栏、1电表、2姓名牌；原crate/盆/绿篱/后廊钢梯剪影/旧生活物保留。不是每户满配或整体完成。
- `stats.facadeLife` 记录按楼局部坐标、原点、种类、层数、逐项tri与招牌位置；总预算900 gate和原30k gate都保留。
- 横招“さくら コインランドリー”，玻璃/旧A-frame“洗濯・乾燥 / セルフサービス”。未虚构房号、营业时间、价格。住宅牌不改用途。

## 图集与所有权

实际CPU完整执行原 `shopsA.build`：lit原5页，末页x624/y0/rowH368；三块512×96、256×96、192×192全部在第5页，结束x984/y368/rowH200。0新texture、0新cacheentry、0新texture pixels。**现有atlas空区像素被更新**，不能说纹理内容没变；已有region不重画。

`laundryAtlasRegions` WeakMap按atlas实例复用，重建city不再次追加。首次 `pixelsUpdated=true`，重建 `false`。追加前按原pad4换行算法预演，若要新页则明确拒绝，未提供fallback。

region材质先经city自己的 `clone()`，保留原hook/cachekey、清除station clip；城市所有文字共用这一个克隆，借原station atlas map。A-frame新文字Plane由city直接拥有，避免把新Plane误当共享primitive而克隆后漏原件。其他原kit geometry仍走现成克隆归属。

实际dispose调用审计：重复city.dispose只产生31个不同material、28个不同geometry各一次释放；0 texture释放，0已登记共享material/geometry释放。重建同一station上下文仍29,933，仍5页且复用原region。原station材质没有被文字克隆替换；后续look的全局行为未在本CPU中执行。

## 几何支撑/范围

- AC浅底座背面接墙、机身距墙1cm；4F后门旁机身边缘距门框约0.175m，侧墙AC横向避开已有窗。为了固定20/21可读，原计划中框外顶层AC改到同一4F第二层另一门侧；5F四台移至侧墙近前角空白处。最终9台风扇点均在20或21至少一机位视锥内，且实际CPU几何首射线抵达该点；这不是alpha/shader/GPU像素证明。
- 金属栏短立杆嵌入现有矮墙顶盖，横杆与立杆相交；衣杆支臂到原墙面、两组布料在矮墙上方且在下层顶板之下。
- 雨管两箍进入墙面，顶弯接西侧屋檐沟；不放落地排水盒，不侵通道。姓名牌背面嵌入墙约0.5mm；横牌背盒嵌雨棚前檐约0.5mm，文字面在背盒前1mm。玻璃贴纸在玻璃前约3mm，A-frame沿原helper的2mm面间距。
- 新外挑仍位于原自行车棚/基础给定整体bounds内；没有新增碰撞或把背景town标成walkable。

## 实际命令 / 文件

全部在 `D:/codex/2026-11-16/world-implementation/handoff`，固定源码base仍0904d87，本地两源dirty，结果内保留确切SHA，不标clean旧commit。

1. `node x51-c15-facade-city-cpu.mjs --candidate`：exit0，真实city/地形/GB/material/GLTF几何；结果 `x51-c15-facade-city-result.json`、stderr同名前缀。
2. 同命令加 `--full-atlas`：exit0，**预期拒绝**容量不足；`x51-c15-facade-atlas-boundary.json`表明pages/x/y/rowH/version/pixels原样。不是一次成功生成新页。
3. `node --check` 两个生产文件：exit0。

CPU driver依赖外部 `x51-c15-full-shops-setup.mjs` 和 `x51-c15-facade-extra-checks.mjs`。完整shopsA的Canvas methods/图片像素是假对象，不能证明实际字体、贴图像素、材质编译或视觉接受。stderr里Three序列化空Texture警告保留。首次新CPU driver缺ctx.onUpdate导致工具失败，修在外部harness，原错误保留 `x51-c15-facade-city-driver-failure1.txt`；不是scene失败，未改产品去适应mock。

## 来源与尚待检查

新增复用仍为Sakuragaoka MIT，具体路径：`world/houses/props.js` (acUnit/elecMeter/plate)、`world/houses/laundry.js`、`world/houses/gb.js`、`world/houses/lot.js` (PAL)、`world/houses/house.js` 私有雨管配方的简化同类几何；文字区域使用 `world/shopsA/common.js` 的Atlas.region/U.text/原A-frame，以及 `core/textures.js` 原FONTS/fitText。全部位于 `upstream/sakuragaoka/src/`，没有新upstream import路径/新纹理/新字体文件；root统一更新source manifest即可。

待root固定20/21/24真实GPU：标识字形/尺寸、玻璃贴纸和A-frame可读性、管/栏/晾衣实际遮挡、共享atlas更新后的受保护站街/店内对照。横招位于原雨棚前檐，24低头近景可能只见A-frame/贴纸，21读横招；不改固定镜头来隐藏问题。不声称C15整体美术验收完成。
