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
assert expected['avoid']==[[-5.5,-4.6]] and geo[0]['floors'][4]['placementArguments']['avoid']==[]
total=sum(m['frames'] for t in timing for m in t['segments'].values())
passed=[sum(t['segments'][k]['pass'] for k in names) for t in timing]
segments=names+['walk-third','walk-first']; labels=['A 站前','B 便利店','C 后巷','D 洗衣店','E 港口','F 山坡','G 铁路','H 北村','第三人称实走','第一人称实走']
out=['# 第八轮补修 · 洗衣店二层包裹和后廊净空',
'比较基线 `'+s['sources']['before']+'` 与补修 `'+s['sources']['after']+'`。基线照片沿用第八轮同提交已核验的 RTX 3060 Laptop 原片；补修版重新拍摄 8 个地面机位、返回 A 及 3 个后廊机位。两版各自新测一轮帧时。所有图为左改前、右补修。',
'## 包裹与门口道具',
'![四层楼二层包裹原像素](rear-4f-parcels-detail.jpg)',
'四层楼二层原有两只包裹的盒体与新增门口道具已分开。两版分别执行生产 buildTownApartment，再捕获其传给 artDoorsteps 的 12 份实参，按对应版本实际 addDoorsteps、盆栽生成器、Frame 与 GB 重建顶点及三角形。窗口绘制在参数跟踪中省略，使用独立随机源；门前道具保持实际种子和生成函数。后廊局部 x 沿墙，z 向外，y 从该层完成地面起算。',
'同一层、同一 `art-r8-door-4-1` 种子和 y = 2.99 m，补修前传入空避让表，补修后为 x = [−5.5, −4.6] m。修前盆栽与两个旧箱都相交，伞桶及其中一把伞与下箱相交。补修后对两箱逐三角形重测，没有新增道具与箱体相交。',
'原来靠箱的伞桶中心 x 从 −4.82 移至 −3.18 米。补修版这一层所有新增几何最靠左到 x = −3.323 米，原箱最靠右到 −4.92 米，两者在墙面水平方向相隔至少 1.597 米。',
table(['后廊几何指标','改前','补修'],[[label]+[fn(g) for g in geo] for label,fn in [
('触及原包裹的网格部件',lambda g:len(g['clearance']['insideUpperParcel'])),('外缘超过 0.5 m 的盆数',outward),('距墙最远的外缘 (m)',lambda g:f"{g['clearance']['maxZ']:.3f}"),('向内穿过后墙的盆数',count_wall),('最大入墙深度 (m)',lambda g:f'{deepest(g):.3f}'),('最小廊板边沿横向余量 (m)',lambda g:f"{g['clearance']['remainingToSlabEdge']:.3f}"),('道具外缘至门洞最小水平距离 (m)',lambda g:f"{g['clearance']['minDoorGap']:.3f}"),('道具三角形',lambda g:g['counts']['triangles'])]]),
'全部 33 盆在朝廊外一侧满足 0.5 m 目标。靠墙一侧仍有 16 盆的叶片进入墙面，最深约 8.2 cm；这是实际网格相对实体墙的几何结果。廊板余量不等同于角色实走净空。三份后廊实拍各自回报的 12 层计数与 CPU 一致，两版均为 23 个伞桶、33 盆植物、22 件小物。两版源码与两份实际运行回执逐项核对，26 枚贴花完整记录相同。',
'残留入墙的具体位置可在四层楼三层复查。该盆栽中心位于 (−1.22, 0, 0.20)，实测顶点 (−1.141, 0.266, −0.082) 进入墙体，整个盆栽离最近门洞水平至少 0.461 米。原始墙体占 z = −0.26 至 0 米。',
'[改前顶点、避让实参与相交证据](geometry-before.json) · [补修顶点、避让实参与相交证据](geometry-after.json)',
'## 同机位实拍','![三栋楼后廊](rear-comparison.jpg)','![C 门前](c-doorsteps.jpg)','![地面 A–D](ground-a-d.jpg)','![地面 E–H](ground-e-h.jpg)',
table(['机位','改变像素','差值大于 2 的像素','最大单通道差值','原始 PNG'],[[k,row['changed'],row['over2'],row['max'],links(k,group)] for field,group in [('views','photos'),('rear','rear')] for k,row in v[field].items()]),
'## RTX 3060 Laptop 帧时',
f"两次独立进程各采 8 个固定机位和两段实际行走，共 {total:,} 个 RAF 间隔。固定机位至少 10 秒，可信 W 步行至少 3 秒；平均 ≥60 FPS 且 P95 ≤16.7 ms 为达标。基线 {passed[0]}/8，补修 {passed[1]}/8。每版只有一轮测量。",
table(['机位','改前 FPS / P95 ms','补修 FPS / P95 ms','改前逐帧绘制次数','补修逐帧绘制次数'],[[label,fmt(timing[0]['segments'][k]),fmt(timing[1]['segments'][k]),calls(timing[0]['segments'][k]),calls(timing[1]['segments'][k])] for k,label in zip(segments,labels)]),
table(['城市场景资源','改前','补修'],[[key,s['city']['before'][key],s['city']['after'][key]] for key in ['geometries','materials','modelPrimitives','totalTriangles','ownedTextures','newTexturePixels']]),
'CPU 单独重建的门前道具少 756 个三角面，整座城市的运行回执少 781 个。4F、5F 两栋分别减少 336、168 面，两种口径一致。3F 整楼少 277 面，独立重建少 252 面，相差 25 面，尚未逐件归因。',
' · '.join(f"[{name}逐帧]({run['tag']}/frames.json.gz)" for name,run in zip(['改前','补修'],timing)),
'## 文件与复算','[逐段总表](summary.json) · [像素差与裁切坐标](visual-summary.json) · [原始回执](receipts) · [处理工具](tools)',
'下载后可运行 `python tools/verify.py` 校验 24 张 PNG 及逐帧重算结果。运行 `python tools/compare.py` 与 `python tools/describe.py` 重建对照和本文。几何复算分别运行 `node tools/geometry.mjs <对应版本的-world-base> geometry-before.json` 和 `node tools/geometry.mjs <补修版本的-world-base> geometry-after.json`。']
(root/'README.md').write_text('\n\n'.join(out)+'\n',encoding='utf8')
