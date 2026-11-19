import json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
def read(filename): return json.loads((root/filename).read_text(encoding='utf8'))
s=read('summary.json'); v=read('visual-summary.json'); g=read('geometry.json')
def table(head,rows):
    return '\n'.join('| '+' | '.join(str(x) for x in row)+' |' for row in [head,['---']*len(head),*rows])
def link(group,name): return f'[改前]({group}/before/{name}.png) · [改后]({group}/after/{name}.png)'
def metric(m):return f"{m['fps']:.2f} / {m['p95Ms']:.1f}"
names=list(v['views'])
first=next(iter(s['rear']['after'].values()))
actual=first['geometry']['doorsteps']
assert len(actual)==len(g['floors'])==12
for row in s['rear']['after'].values(): assert row['geometry']['doorsteps']==actual
same=all(all(a[k]==b[k] for k in ['stands','pots','small']) for a,b in zip(actual,g['floors']))
assert same,'Review differences between CPU and live counts before finalizing'
live={k:sum(x[k] for x in actual) for k in ['stands','pots','small']}
assert s['city']['after']['artDoorsteps']==actual
labels=['A 站前主街','B 便利店','C 公寓后巷','D 洗衣店','E 港镇码头','F 东部山坡','G 铁路边','H 北村']
timing=s['timing']; passed=[sum(t['segments'][k]['pass'] for k in names) for t in timing]
total=sum(sum(m['frames'] for m in t['segments'].values()) for t in timing)
def ranges(m):
    return str(m[0]) if m[0]==m[1] else f'{m[0]}–{m[1]}'
def groupstats(rr): return [rr[k] for k in ['calls','triangles']]
excluded=root/'excluded'
intro=['# 第八轮公寓后廊门前陈设','基线 `'+s['sources']['before']+'`，候选 `'+s['sources']['after']+'`。RTX 3060 Laptop、1440 × 900，同机位图均左改前、右改后。',
'## 地面 C 与三栋后廊','![C 后巷门前原像素裁切](c-doorsteps.jpg)',
'C 近处门边增加伞具，手推车旁可见一盆带花植株，向后可见另一盆绿植。楼梯仍遮住后方部分门廊。',
'![三栋后廊固定机位](rear-comparison.jpg)',
'三层楼一层门边可见单放的折伞、伞桶和小盆栽，二层栏杆后可见红色小桶及绿植；五层楼中门旁出现两盆并排植物，楼上有蓝色小桶。四层楼二层近照能看到绿叶从上箱顶面伸出。',
table(['机位','改变像素','最大单通道差值','原始 PNG'],[[k,v['rear'][k]['changed'],v['rear'][k]['max'],link('rear',k)] for k in v['rear']]),
'## 数量与模型净空',
f"三栋楼共 12 段后廊、36 扇门。三次补拍的实际场景计数逐层一致，共 {live['stands']} 只伞桶、{live['pots']} 盆植物和 {live['small']} 件小件。CPU 用提交中的种子、道具函数、Frame 和 GB 重新生成各层顶点，12 段分项与实际场景全部吻合。小件包含 {g['pieceCounts']['folded']} 把单放折伞、{g['pieceCounts']['bucket']} 只水桶和 {g['pieceCounts']['wateringCan']} 个洒水壶。道具合计 {g['counts']['triangles']:,} 个三角形。作者提交说明写了 25 只伞桶。",
table(['楼栋与楼层','伞桶','盆栽','小件','新增三角面'],[[f"{r['site']} · {r['floor']} 层",r['stands'],r['pots'],r['small'],r['triangles']] for r in g['floors']]),
table(['运行时城市场景','改前','改后'],[[key,s['city']['before'][key],s['city']['after'][key]] for key in ['geometries','materials','modelPrimitives','totalTriangles','ownedTextures','newTexturePixels']]),
'![四层楼二层的原有包裹与新增门边道具，原像素裁切](rear-4f-parcels-detail.jpg)',
'**四层楼二层左门的新增盆栽和伞桶与原有包裹发生穿插。** 以该层后墙为原点轴面，盆栽中心 x = −5.22、z = 0.24 米，盆栽实际三角形与上下两个原有箱体都相交。伞桶 x = −4.82、z = 0.20 米，其筒体与下箱相交。上层将避让区传为空数组。两层箱体分别为 0.46 × 0.27 × 0.36 和 0.34 × 0.18 × 0.30 米。通过实际新道具三角形与原箱实体盒相交判定，同时保留前后实拍。 [四层楼改前原图](rear/before/rear-4f-parcels.png) · [改后原图](rear/after/rear-4f-parcels.png) · [几何逐件回执](geometry.json)',
f"按楼层归一到后墙 z = 0，所有新增几何与 1.03 米宽的门洞水平投影至少间隔 {g['clearance']['minDoorGap']:.3f} 米，与一层已声明的纸箱、扫帚预留 x 区间至少间隔 {g['clearance']['minAvoidSpanGap']:.3f} 米。道具中心靠墙，14 盆植物的外缘超过 0.5 米，最远延至 z = {g['clearance']['maxZ']:.3f} 米。至 1.05 米廊板边沿的最小剩余横向宽度为 {g['clearance']['remainingToSlabEdge']:.3f} 米，至外梯平台近边沿的保守 z 向间距为 {g['clearance']['remainingToStairLanding']:.3f} 米。本组为模型几何测量，角色实走段在另外的街道路线。",
'有 15 盆植株的实际顶点伸入后墙。最深处在四层楼三层，局部坐标 (−1.266, 0.371, −0.113) 米，墙体 z 范围为 −0.26 至 0 米，这盆植物的水平外缘与门洞间隔 0.401 米。绿叶也因此可能被墙面遮住一部分。',
f"烘焙场景指纹 {g['decals']['fingerprints'][0]} → {g['decals']['fingerprints'][1]}。两版源码和两份真实运行回执均逐项核对了 26 枚贴花的完整记录，10 海报、14 贴纸和 2 涂鸦的坐标、朝向、大小均相同。4 个 GLB 和 9 个公寓纹理文件逐个哈希相同。 [运行材质与资源指纹](summary.json)",
'## A–H 与历史机位','![A 至 D](ground-a-d.jpg)','![E 至 H](ground-e-h.jpg)',
'用同一提交再启动的一次对照中，A、B、C、D、F、G、H 逐像素一致，E 港口已有 5,088 个像素变化。当轮两版 E 相差 4,581 像素，单凭这两张照片无法将这些变化归于后廊道具。[同提交复拍结果](baseline-recapture.json)',
table(['机位','改变像素','差值 > 2','最大差值','两张原图'],[[name,v['views'][k]['changed'],v['views'][k]['over2'],v['views'][k]['max'],link('photos',k)] for k,name in zip(names,labels)]),
'![五个历史机位](legacy-comparison.jpg)',
table(['历史机位','改前 FPS / P95','改后 FPS / P95','改变像素','原图'],[[k,metric(s['legacy']['before'][k]),metric(s['legacy']['after'][k]),v['historical'][k]['changed'],link('legacy',k)] for k in s['legacy']['before']]),
'## 帧时与绘制次数',
f'正式成绩共 {total:,} 个帧间隔。每个固定机位至少 10 秒，第三、第一人称各至少 3 秒，可信 W 输入。顺序为改前、改后、改后、改前。均值 ≥ 60 FPS 且 P95 ≤ 16.7 毫秒为达标。四轮固定机位达标数分别为 '+'、'.join(str(n)+'/8' for n in passed)+'。',
table(['机位','改前 1 FPS / P95','改后 1','改后 2','改前 2'],[[label]+[metric(t['segments'][k]) for t in timing] for k,label in zip(names+['walk-third','walk-first'],labels+['第三人称步行','第一人称步行'])]),
'下表是同一固定机位所有有效帧的绘制调用范围。动态内容和渲染通道会影响实际调用；原始样本也保留各帧三角数量。',
table(['机位','改前 1 调用','改后 1','改后 2','改前 2'],[[label]+[ranges(t['segments'][k]['calls']) for t in timing] for k,label in zip(names,labels)]),
'C 后巷两次基线各帧的调用范围均为 '+ '、'.join(ranges(timing[i]['segments'][names[2]]['calls']) for i in [0,3])+'，两次候选分别为 '+ '、'.join(ranges(timing[i]['segments'][names[2]]['calls']) for i in [1,2])+'。实测调用数随候选上升。固定机位门槛按每轮计分，两个候选运行中达标机位均是 B、C、D、F、H。',
'三栋后廊补拍时连续渲染了多次，回执里的 renderer.info 计数没有在每帧前明确复位。上表采用帧时工具逐帧记录的绘制调用。',
' · '.join(f"[{t['tag']} 逐帧]({t['tag']}/frames.json.gz)" for t in timing),
'## 复核与复现','[完整结果](summary.json) · [图像差异](visual-summary.json) · [模型空间数据](geometry.json) · [原始回执](receipts) · [采集脚本](tools)',
'下载归档后，在根目录运行以下命令可校验原图哈希、逐帧摘要，重建图片及表格。使用 Python 3、NumPy、Pillow 与微软雅黑。几何重放使用 Node 24 和两版原始 fixture。',
'采集恢复方法为分别检出两版提交，并用网络审计提交 `0db21d2df3ed097d4f3414539b92e8eadcc12b75` 的 world-base fixture。将 tools 的 CJS、cameras.json 和 sources.json 复制到空采集目录。对两个工作树的 world-base 运行 `node measure-ground.cjs <基线fixture> <候选fixture> <审计fixture> <electron.exe> r8-native-repeat`。专项目录及额外相机公式见 [rear-r8.cjs](tools/rear-r8.cjs)。归档再生成使用 `python tools/archive.py <采集目录>`。',
'```text\npython tools/verify.py\npython tools/compare.py\npython tools/describe.py\nnode tools/geometry.mjs <改前-world-base> <改后-world-base> geometry.json\n```']
if excluded.exists(): intro.insert(intro.index('## 复核与复现'),'退出失败的进程单独保存，未计入四轮正式成绩。[失败尝试和原始回执](excluded)')
(root/'README.md').write_text('\n\n'.join(intro)+'\n',encoding='utf8')
