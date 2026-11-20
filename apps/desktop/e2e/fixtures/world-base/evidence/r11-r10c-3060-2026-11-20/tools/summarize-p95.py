#!/usr/bin/env python3
"""按 C酱 定的口径汇总：每帧 GPU 合计时间的 P95，多轮取中位。"""
import glob
import json
import os
import statistics as st

D = r'E:\agent-review-room\.tmp\x51-tools\records'

rows = {}
for f in sorted(glob.glob(os.path.join(D, 'real-*.json'))):
    try:
        j = json.load(open(f, encoding='utf-8'))
    except Exception:
        continue
    lab = j.get('label', '')
    if lab.startswith('bp95-'):
        side = 'base'
    elif lab.startswith('cp95-'):
        side = 'cand'
    else:
        continue
    for r in j.get('results', []):
        if r.get('gpuFrameP95') is None:
            continue
        rows.setdefault((side, r['view']), []).append(r)

views = sorted({v for (_, v) in rows})
col = '{:<22}{:>12}{:>12}{:>9}{:>10}{:>9}{:>7}'
print(col.format('view', '基线封P95', '候选帧P95', 'Δ', '候选帧P50', '调用数', '轮数'))
print('-' * 78)

alerts = []
for v in views:
    b = rows.get(('base', v), [])
    c = rows.get(('cand', v), [])
    if not b or not c:
        continue
    bp = st.median([x['gpuFrameP95'] for x in b])
    cp = st.median([x['gpuFrameP95'] for x in c])
    c50 = st.median([x['gpuFrameP50'] for x in c if x.get('gpuFrameP50') is not None])
    calls = st.median([x['renderCalls'] for x in c if x.get('renderCalls')])
    print(col.format(v, f'{bp:.2f}', f'{cp:.2f}', f'{cp-bp:+.2f}', f'{c50:.2f}', f'{calls:.0f}', f'{len(b)}/{len(c)}'))
    if cp > 16.7:
        alerts.append((v, cp))

print()
if alerts:
    print('未达标（每帧 GPU 合计 P95 > 16.7 ms）:')
    for v, cp in alerts:
        print(f'  {v}: {cp:.2f} ms')
else:
    print('全部机位达标：每帧 GPU 合计 P95 ≤ 16.7 ms')
