"""Write numeric ground/spill review from checked original captures."""
import json
from pathlib import Path
import gzip
root=Path(__file__).resolve().parents[1]
read=lambda p:json.loads((root/p).read_bytes())
s=read('summary.json')
m=read('special/measurements.json')
r=json.loads(gzip.decompress((root/'special/report.json.gz').read_bytes()))
lines=['# 第十轮街面复测','',f"基线 `{s['sources']['before']}`，候选 `{s['sources']['after']}`。原生 RTX 3060 Laptop、1440 × 900、黄昏固定时钟 14。改前照片复用第九轮原件，帧时两版各自启动一次。",'','初次提交 `77f28ef` 的门灯顶点程序使用了未声明的 vEdge，首镜返回 WebGL 1282，进程退出 1。该次没有可用照片或逐帧数据，原始报告、日志与源码在 `failed-77f28ef/`。','','## 专项照片与归因','','B、D 和 #84 在第九轮有独立同位照片。每个专项还保留本轮同进程冻结画面的关闭、开启及重复开启原图。切换 #84 时只动门灯组，其余镜头只动店面地光；各镜重复开启哈希一致。shop-b-edge 和 shop-warm 只有本轮同次开关。每张接触表从左向右按英文标签区分来源，局部 PNG 保留拍摄像素。','','差异像素按任一 RGB 通道变化超过 2 个 8 位色阶计；亮度为截图编码 RGB 的 Rec.709 加权和。新增白色要求三通道同时 255。','','| 镜头 | R9→开启 差异像素 | 关闭→开启 差异像素 | 变化像素亮度增量中位/P90 | 新增三通道纯白/近白≥250 | 整帧 calls 关→开 |','|---|---:|---:|---:|---:|---:|']
for key,row in m.items():
    metric=row['offOn']; p=metric['lumaDeltaP10P50P90P99_over2']; draw=row['draw']
    lines.append(f"| {key} | {row.get('independent',{}).get('over2','—')} | {metric['over2']} | {str([p[1],p[2]]) if p else '—'} | {metric['allRGB255']['new']} / {metric['allRGB250']['new']} | {draw['off']['render']['calls']} → {draw['on']['render']['calls']} |")
lines+=['','## 表面与距离','','下射线排除光斑面自身。Δy 为光片采样点高度减去首个有效实体命中高度；正值表示片在该表面上方。采样覆盖及命中对象路径存于原报告。']
for key,shot in r['photos'].items():
    sp=shot['special']
    if 'door' in sp:
        d=sp['door'];lines+=['',f"#84 实例实际横向界限 {d['edge']} m。距墙向外 0.40 m 时：",'','| 切向偏移 m | 边缘权重 | 片元权重 | Δy m |','|---:|---:|---:|---:|']
        for a in d['samples']:
            h=a['floor']['hit'];lines.append(f"| {a['side']:+.2f} | {a['edgeWeight']:.6f} | {a['weight']:.6f} | {h['heightDelta']:.6f} |" if h else f"| {a['side']:+.2f} | {a['edgeWeight']:.6f} | {a['weight']:.6f} | 未命中 |")
    else:
        d=sp['shop']; heights=[a['floor']['hit']['heightDelta'] for a in d['support'] if a['floor']['hit']];front=d['selected']
        lines+=['',f"{key}，{front['name']} / {front['kind']}，门面宽 {front['width']:.3f} m。此店 {len(d['segments'])} 个分片，最大外伸 {max(a['d1'] for a in d['segments']):.3f} m。{len(heights)}/{len(d['support'])} 个有实体命中的样点，Δy 范围 {min(heights):+.4f} 至 {max(heights):+.4f} m。" if heights else f"{key} 无实体命中。"]
lines+=['','## 帧时','','固定镜位按 FPS ≥60 且 P95 ≤16.7 ms 判定。步行各录两视角，含可信 W 输入和位移。原始帧间隔及对应 draw calls 位于 timing/。','','| 镜头 | 基线 FPS / P95 ms | 候选 FPS / P95 ms | 基线 calls 范围 | 候选 calls 范围 |','|---|---:|---:|---:|---:|']
before,after=[a['segments'] for a in s['timing']]
for k,x in before.items():
    y=after[k];lines.append(f"| {k} | {x['fps']:.2f} / {x['p95Ms']:.1f} | {y['fps']:.2f} / {y['p95Ms']:.1f} | {x['calls']} | {y['calls']} |")
lines+=['','原始回执含 26 个烘焙贴花的完整登记，以及 9 张公寓纹理与 4 个模型包的哈希。两版逐条比对相同。可在任意目录运行 `python tools/verify.py`（脚本路径相对本归档），重算原片哈希、帧率与 P95/P99。']
lines.insert(lines.index('## 表面与距离'),(root/'tools/interpretation.md').read_text(encoding='utf8'))
(root/'README.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
