import json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
read=lambda p: json.loads((root/p).read_bytes())
s=read('summary.json'); v=read('visual-summary.json')
arms=['before','after']
geo=[read('geometry-'+arm+'.json') for arm in arms]
assert geo[0]['decals']['items']==geo[1]['decals']['items']==s['assets']['before']['bakedItems']==s['assets']['after']['bakedItems']
for arm,g in zip(arms,geo):
    cpu=[{k:r[k] for k in ['stands','pots','small']} for r in g['floors']]
    assert cpu==s['city'][arm]['artDoorsteps']
    for r in s['rear'][arm].values(): assert cpu==r['geometry']['doorsteps']
def count_wall(g):return sum(r['wallSpaceVertex'] is not None for r in g['records'])
def outward(g):return sum(r['max'][2]>.5 for r in g['records'] if r['kind']=='pot')
def deepest(g):return abs(min(r['min'][2] for r in g['records']))
def table(head,rows):return '\n'.join('| '+' | '.join(map(str,row))+' |' for row in [head,['---']*len(head),*rows])
def links(k,group):return f'[改前]({group}/before/{k}.png) · [补修]({group}/after/{k}.png)'
def fmt(m):return f"{m['fps']:.2f} / {m['p95Ms']:.1f}"
def calls(m):return '–'.join(map(str,m['calls'])) if m['calls'][0]!=m['calls'][1] else str(m['calls'][0])
names=list(v['views'])
timing=s['timing']
expected=geo[1]['floors'][4]['placementArguments']
assert expected['avoid']==geo[0]['floors'][4]['placementArguments']['avoid']==[[-5.5,-4.6]]
pots=[[r for r in g['records'] if r['kind']=='pot'] for g in geo]
inner=[min(rows,key=lambda r:r['min'][2]) for rows in pots]
outer=[max(rows,key=lambda r:r['max'][2]) for rows in pots]
assert all(r['minZVertex']['material']=='foliage' for r in inner)
assert all(r['maxZVertex']['material']=='foliage' for r in outer)
total=sum(m['frames'] for t in timing for m in t['segments'].values())
passed=[sum(t['segments'][k]['pass'] for k in names) for t in timing]
segments=names+['walk-third','walk-first']; labels=['A 站前','B 便利店','C 后巷','D 洗衣店','E 港口','F 山坡','G 铁路','H 北村','第三人称实走','第一人称实走']
out=['# 第八轮第二次补修 · 公寓盆栽叶片与后墙',
'比较 R8b `'+s['sources']['before']+'` 与 R8c `'+s['sources']['after']+'`。基线照片沿用 R8b 同提交已核验的 RTX 3060 Laptop 原片；R8c 重新拍摄 8 个地面机位、返回 A 及 3 个后廊机位。两版各自新测一轮帧时。所有图为左 R8b、右 R8c。',
'## 叶片净空',
'R8c 将盆栽缩放从 0.75 调到 0.62，中心 z 从 0.20 移至 0.245 米。以各层实际后墙外表面为 z = 0，向廊外为正；逐一重建 33 盆的所有几何顶点，内外极值均属于 foliage 材质。R8b 有 16 盆叶片进入墙体，R8c 为 0。R8c 最内侧距墙 10.397897340 毫米，最外侧距 0.50 米边界 2.230868327 毫米。',
table(['盆栽真实顶点','R8b','R8c'],[['最小 z（米）']+[f"{r['min'][2]:.12f}" for r in inner],['最大 z（米）']+[f"{r['max'][2]:.12f}" for r in outer],['最小值所在位置']+[f"{r['site']} 楼 · 第 {r['floor']} 层" for r in inner],['最大值所在位置']+[f"{r['site']} 楼 · 第 {r['floor']} 层" for r in outer]]),
'R8c 两个极值来自三层公寓的二层盆栽。最近顶点局部坐标 (−1.481549137, 0.198282482, 0.010397897) 米，最远顶点为 (−1.561639526, 0.198282482, 0.497769132) 米。Y 从该层完成地面起算。这些是生产道具几何的 CPU 重放值，GPU 回执另行核对同眼位成片、场景资源和逐层道具数量。',
'## 包裹与门口道具',
'![四层楼二层包裹原像素](rear-4f-parcels-detail.jpg)',
'两版分别执行原始 buildTownApartment，捕获其传给 artDoorsteps 的 12 份实参，按对应版本的 addDoorsteps、盆栽生成器、Frame 与 GB 重建顶点及三角形。参数跟踪省略使用独立随机源的窗口绘制。',
'四层楼二层两版均传入 x = [−5.5, −4.6] 米避让区，楼层 y = 2.99 米、种子为 `art-r8-door-4-1`。两版逐三角形对照两只原包裹的实体盒，均无道具相交。',
table(['后廊几何指标','改前','补修'],[[label]+[fn(g) for g in geo] for label,fn in [
('触及原包裹的网格部件',lambda g:len(g['clearance']['insideUpperParcel'])),('外缘超过 0.5 m 的盆数',outward),('向内穿过后墙的盆数',count_wall),('最小廊板边沿横向余量 (m)',lambda g:f"{g['clearance']['remainingToSlabEdge']:.6f}"),('道具外缘至门洞最小水平距离 (m)',lambda g:f"{g['clearance']['minDoorGap']:.6f}"),('道具三角形',lambda g:g['counts']['triangles'])]]),
'三份后廊实拍各自回报的 12 层计数与 CPU 一致，两版均为 23 个伞桶、33 盆植物、22 件小物。两版源码与两份实际运行回执逐项核对，26 枚贴花的完整记录相同。廊板余量为静态几何距离。',
'[改前顶点、避让实参与相交证据](geometry-before.json) · [补修顶点、避让实参与相交证据](geometry-after.json)',
'## 同机位实拍','![三栋楼后廊](rear-comparison.jpg)','![C 门前](c-doorsteps.jpg)','![地面 A–D](ground-a-d.jpg)','![地面 E–H](ground-e-h.jpg)',
table(['机位','改变像素','差值大于 2 的像素','最大单通道差值','原始 PNG'],[[k,row['changed'],row['over2'],row['max'],links(k,group)] for field,group in [('views','photos'),('rear','rear')] for k,row in v[field].items()]),
'## RTX 3060 Laptop 帧时',
f"两次独立进程各采 8 个固定机位和两段实际行走，共 {total:,} 个 RAF 间隔。固定机位至少 10 秒，可信 W 步行至少 3 秒；平均 ≥60 FPS 且 P95 ≤16.7 ms 为达标。基线 {passed[0]}/8，补修 {passed[1]}/8。每版只有一轮测量。",
table(['机位','改前 FPS / P95 ms','补修 FPS / P95 ms','改前逐帧绘制次数','补修逐帧绘制次数'],[[label,fmt(timing[0]['segments'][k]),fmt(timing[1]['segments'][k]),calls(timing[0]['segments'][k]),calls(timing[1]['segments'][k])] for k,label in zip(segments,labels)]),
table(['城市场景资源','改前','补修'],[[key,s['city']['before'][key],s['city']['after'][key]] for key in ['geometries','materials','modelPrimitives','totalTriangles','ownedTextures','newTexturePixels']]),
'门前道具 CPU 重放两版均为 10,884 个三角面。两版实机实际加载的公寓、门口道具、种子、网格与植株生成模块（共六个文件）与 CPU 重放使用的文件逐一同哈希。[源码哈希及场景回执汇总](summary.json)',
'全城运行回执为 95,475 → 95,500 面，25 面差异全部在三层楼整栋（12,221 → 12,246）。四层和五层楼的整楼面数持平。这 25 面未定位到具体几何部件。',
' · '.join(f"[{name}逐帧]({run['tag']}/frames.json.gz)" for name,run in zip(['改前','补修'],timing)),
'## 文件与复算','[逐段总表](summary.json) · [像素差与裁切坐标](visual-summary.json) · [原始回执](receipts) · [处理工具](tools)',
'下载后可运行 `python tools/verify.py` 校验 24 张 PNG 及逐帧重算结果。运行 `python tools/compare.py` 与 `python tools/describe.py` 重建对照和本文。几何复算分别运行 `node tools/geometry.mjs <对应版本的-world-base> geometry-before.json` 和 `node tools/geometry.mjs <补修版本的-world-base> geometry-after.json`。']
(root/'README.md').write_text('\n\n'.join(out)+'\n',encoding='utf8')
