import json,gzip
from pathlib import Path
root=Path(__file__).resolve().parents[1]
read=lambda f:json.loads((root/f).read_bytes())
s=read('summary.json'); v=read('visual-summary.json');toggle=read('toggle-summary.json');probes=read('support-probes.json')
r=json.loads(gzip.decompress((root/'door-glow/report.json.gz').read_bytes()))
registry=r['photos']['corridor-c']['special']['registry']
group=r['photos']['corridor-c']['special']['groups']
def table(head,rows):return '\n'.join('| '+' | '.join(map(str,rr))+' |' for rr in [head,['---']*len(head),*rows])
def links(k,dir):return f'[改前]({dir}/before/{k}.png) · [候选]({dir}/after/{k}.png)'
def togglelinks(k):return f'[关](door-glow/{k}-off.png) · [开](door-glow/{k}-on.png) · [重复开](door-glow/{k}-repeat-on.png)'
def tup(a):return ' / '.join(map(str,a))
def number(x):return f'{x:,.0f}'
def fmt(m):return f"{m['fps']:.2f} / {m['p95Ms']:.1f}"
def call(m):return str(m['calls'][0]) if m['calls'][0]==m['calls'][1] else '–'.join(map(str,m['calls']))
timing=s['timing'];views=list(v['views']);keys=views+['walk-third','walk-first']
total=sum(m['frames'] for t in timing for m in t['segments'].values())
counts=registry['beforeDedup']
far=[q for q in registry['farHouseLamps']]
dr=toggle['corridor-c']['draw']
def new_pixels(k,metric): return toggle[k]['offOn'][metric]['new']
def hitrow(q,p):
    w,f=p['wall'],p['floor'];h=f['surface']
    return [str(q['lampId']),p['side'],f"{w['surface']['error']:.3f}" if w['surface'] else '无近邻',f"{w['normalDot']:.3f}" if w['normalDot'] is not None else '—',f"{h['error']:.3f}" if h else '无近邻',f"{f['normalDot']:.3f}" if f['normalDot'] is not None else '—',tup(f['projectedPixel'] or []),tup(f['deltaRGB'] or [])]
out=['# 第九轮门灯光斑 · RTX 3060 Laptop 实机',
'基线 `'+s['sources']['before']+'`，候选 `'+s['sources']['after']+'`。基线地面照片沿用同提交的 R8c 原片，候选 A–H 重新拍摄；两版各做一轮帧时。另在候选同一次启动中冻结相机和时钟，按关、开、重复开拍七个机位。原图 1440 × 900，傍晚。',
'## 画面与高光','![后廊门灯原像素](c-door-light.jpg)',
'后廊 C 近处灯下出现橙色光斑，墙面纹理仍可见，远处两灯也在墙、地上形成局部亮区。A、B、G 的小光斑分别位于街边招牌旁、便利店玻璃后的远处和铁路侧住宅门口；下图按两版原图中最大连通变化区作双倍最近邻放大。D 固定机位两版逐像素一致。',
'![A B G 光斑局部](abg-detail.jpg)','![固定镜头同次开关](fixed-doors.jpg)',
'下表使用候选同机位开关两张原始 RGB 图。白点为三个通道均等于 255，近白为三个通道均至少 250；单通道到顶单独列出。只统计从关到开新达到该阈值的像素。最大差表示 8 位单通道最大绝对差。重复开差异用来检验冻结是否稳定。',
table(['机位','RGB 变化 >2','新增纯白','新增近白','新增 R/G/B=255','最大差','重复开变化像素','原图'],[[k,number(x['offOn']['over2']),new_pixels(k,'allRGB255'),new_pixels(k,'allRGB250'),tup([x['offOn']['perChannel255'][c]['new'] for c in 'RGB']),x['offOn']['maxDelta'],x['repeat']['changed'],togglelinks(k)] for k,x in toggle.items()]),
'七个机位均未新增三通道近白或纯白像素，远排中段新增 2,554 个红通道到顶的像素，其余两个通道均未新增到顶。七张重复开启控制图与首次开启的原图逐像素相同。',
'## 灯位、远排住宅与支承面',
f"实际登记包含 {counts['apartment']} 盏城镇公寓灯和 {registry['rawTotal']} 盏上游灯，其中住宅 {counts['houses']}、商铺 {counts['shops']}、车站 {counts['station']}。位置去重后有 {registry['resolvedTotal']} 盏，{registry['wallOnly']} 盏只做墙面光斑。两张实例网格各分配 {group[0]['count']} 个位置，无地面光斑的实例使用零缩放。没有增加点光源和阴影投射。",
f"住宅登记局部 z ∈ [−75,−60] 的有 {registry['farHouseCount']} 盏。按 x 排序取 15%、50%、85% 位置，选中灯号 "+'、'.join(str(q['lampId']) for q in probes)+'。三镜使用真实灯位和朝外法线构图。',
'![远排住宅同次开关](far-doors.jpg)',
'该区间的 20 个住宅登记法线全部朝局部 +Z，其中 14 盏位于 z 约 −60 米，6 盏位于 z 约 −74 米。上述按 x 排序的三镜都落在 −60 米一排。三灯中心墙面射线都命中与预期外法线一致的面，门廊中心向下也都命中同高的水平实体。西、东机位的中心地面像素分别增加 RGB (121,78,38)、(115,78,36)，中间机位的门和围墙挡住大部分地面，中心像素只变 (0,1,0)。墙面亮斑可见于三镜。',
'住宅生成代码把灯放在靠外的门侧，灯的投影至同侧门廊边缘仅 0.23 米。地面着色器横向半径 1.2 米，缺少按门廊宽度收边的控制。离灯中心横向 0.40 米、离墙 0.40 米处已越出台沿 0.17 米，剩余强度系数 0.516732，线性 RGB 加值约 (0.180856, 0.099471, 0.045214)。在无邻近承托时，这部分会留在与门廊齐高的平面上。[源码尺寸与着色器复算](shader-support.json)',
'射线采样过滤了光斑自身和不写深度的材质。表中墙误差沿墙法线向内测，正值表示受测不透明面在目标墙面后方；地面误差向下测，正值表示实际受测面低于预定门廊高度。方向列为命中法线与预期外法线或向上法线的点积。屏幕位置和开关前后 3×3 像素 RGB 中位差来自原片，可与各侧探针互查。',
table(['灯号','横移 m','墙误差 m','墙方向','地面落差 m','地面方向','画面 x/y','ΔR/G/B'],[hitrow(q,p) for q in probes for p in q['samples']]),
'![三个灯位的地面探针投影，标注为沿墙横移米数](floor-probes.jpg)',
'东侧灯 #84 位于世界坐标 (339.255,10.260,839.459)。沿切线 +0.40 米、离墙 0.40 米处，最近不透明水平面比预定门廊面低 0.290 米，加上光斑自身 0.012 米抬高，该处光斑几何距支承面 0.302 米。西侧 #74 横移 −0.65 米处实际水平面也低了 0.050 米。两点投影原片的 3×3 RGB 中位差均为 (0,0,0)，此次相机没有记录到两点可见的悬浮亮斑。几何缺口仍可按坐标复现。',
'同样横移 −0.40 米，#74 和 #79 的向下射线分别先命中 y = 8.616 和 8.495 米的倾斜物体，两处都高于 y = 8.322 米的光斑平面。此处可发生遮挡，不能计作悬空距离。两点的开关 RGB 中位差分别为 (0,1,0) 和 (0,0,0)。',
'[逐点实物命中、坐标与 RGB](support-probes.json) · [完整实机回执](door-glow/report.json.gz)',
'## 绘制次数和帧时','冻结测量每次重置渲染器计数。以下墙、地计数来自对应实例网格的实际渲染提交，全帧计数同时含场景和后处理。',
table(['机位','全帧关→开','全帧增量','墙提交','地提交','全帧三角面关→开'],[[k,f"{x['draw']['off']['render']['calls']} → {x['draw']['on']['render']['calls']}",x['draw']['on']['render']['calls']-x['draw']['off']['render']['calls'],x['draw']['on']['submissions']['door-glow-wall'],x['draw']['on']['submissions']['door-glow-floor'],f"{x['draw']['off']['render']['triangles']:,} → {x['draw']['on']['render']['triangles']:,}"] for k,x in toggle.items()]),
f"两次独立计时合计 {total:,} 个有效 RAF 帧间隔。固定机位至少 10 秒，两种可信 W 步行各至少 3 秒。平均至少 60 FPS 且 P95 至多 16.7 ms 定为达标，基线和候选分别为 "+'、'.join(str(sum(t['segments'][k]['pass'] for k in views))+'/8' for t in timing)+'。',
table(['机位','改前 FPS / P95 ms','候选 FPS / P95 ms','改前每帧调用','候选每帧调用'],[[k,fmt(timing[0]['segments'][k]),fmt(timing[1]['segments'][k]),call(timing[0]['segments'][k]),call(timing[1]['segments'][k])] for k in keys]),
' · '.join(f"[{label}逐帧]({t['tag']}/frames.json.gz)" for label,t in zip(['改前','候选'],timing)),
'## 资源与原图','三个上游灯登记模块的实际 HTTP 响应均与对应版本的仓库文件相同。两套工作树中的 .local 原件各自匹配固定的 source-files 清单。4 个 GLB、9 张公寓纹理逐文件同哈希，26 枚贴花的完整 bakedItems 与两版运行回执逐项一致。[上游三文件与缓存指纹](upstream-transport.json) · [候选 Git 与传输验证](door-glow/verification.json) · [运行与资源总表](summary.json)',
'![A–D](ground-a-d.jpg)','![E–H](ground-e-h.jpg)',
table(['地面机位','改变像素','差值 >2 像素','两版原图'],[[k,number(row['changed']),number(row['over2']),links(k,'photos')] for k,row in v['views'].items()]),
'## 下载后复算','运行 `python tools/verify.py` 校验正式照片与帧时，`python tools/diagnostic.py` 独立校验开关原图及高光数，`python tools/probes.py` 复算世界探针投影，`python tools/compare.py` 和 `python tools/regions.py` 重建对照图，最后运行 `python tools/describe.py` 重建本文。图像分析使用 Python、Pillow、NumPy 及微软雅黑。']
deep=read('deep-toggle-summary.json')['far-west']
deeps=read('deep-support-probes.json')[0]
loc=out.index('## 绘制次数和帧时')
out[loc:loc]=['### 第二排住宅补拍',
'单独重启候选，选择 z ∈ [−75,−70] 的 6 盏住宅灯之一。灯 #91 局部坐标 (−40.135, 2.260, −74.455)，法线朝 +Z。门左外墙在开启时可见橙色光斑，地面被前景院墙和门挡住。开关两图有 69,178 个像素的最大单通道差超过 2，重复开启逐像素一致。全帧绘制 921 → 923，墙、地各多一次提交。',
'![−74 米一排灯 #91](deep-row.jpg)',
'中心台面射线命中同高的水平物体，中心投影的 RGB 中位差是 (1,1,0)。左移 0.4 米及 0.65 米的位置，最近实物分别高于预定台面 0.296、0.300 米，投影中都没有 RGB 变化。下表与第一组采用同一误差符号。',
table(['灯号','横移 m','墙误差 m','墙方向','地面落差 m','地面方向','画面 x/y','ΔR/G/B'],[hitrow(deeps,p) for p in deeps['samples']]),
'该镜新增纯白和近白均为 0，新增单通道 R/G/B 到顶分别为 '+tup([deep['offOn']['perChannel255'][c]['new'] for c in 'RGB'])+'。[关](door-glow-deep-row/far-west-off.png) · [开](door-glow-deep-row/far-west-on.png) · [重复开](door-glow-deep-row/far-west-repeat-on.png) · [探针数据](deep-support-probes.json) · [实机回执](door-glow-deep-row/report.json.gz)']
out.append('第二排独立进程使用 `python tools/diagnostic.py --deep` 核验三张原片，`python tools/probes.py --deep` 重建投影。')
(root/'README.md').write_text('\n\n'.join(out)+'\n',encoding='utf8')
