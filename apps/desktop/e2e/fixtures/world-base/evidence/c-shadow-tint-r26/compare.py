# python3 compare.py <dir> : on/off and a53236b-vs-r26 numbers from shot.cjs PNGs (960x600). Regions are 林离's c25 rects (1440x900) scaled by 2/3.
import sys, json, numpy as np
from PIL import Image
d = sys.argv[1]
def img(n): return np.asarray(Image.open(f'{d}/{n}.png').convert('RGB')).astype(int)
def stat(a, b, rect=None):
    if rect:
        x0, y0, x1, y1 = [round(v * 2 / 3) for v in rect]; a, b = a[y0:y1, x0:x1], b[y0:y1, x0:x1]
    df = np.abs(a - b).max(axis=2)
    return dict(px=int(df.size), above8=int((df > 8).sum()), above1=int((df > 1).sum()), max=int(df.max()), meanRGB=[round(float((b - a)[..., i].mean()), 2) for i in range(3)])
R = {'door-eye': {'doorFrame': [680, 150, 730, 600], 'street': [840, 600, 1080, 670], 'oppositeFacade': [1020, 240, 1080, 360]},
     'station-street': {'road': [715, 720, 990, 835], 'E3upper': [1220, 175, 1340, 230]},
     'street-detail': {'pavement': [410, 725, 595, 790], 'bench': [965, 675, 1085, 700]}}
names = {'shop-door-eye': 'door-eye', 'station-street': 'station-street', 'street-detail': 'street-detail'}
out = {}
off = lambda v: img(f'{v}-n-off-r26'); on = lambda v: img(f'{v}-n-on-r26'); old = lambda v: img(f'{v}-a53-on')
for v, k in names.items():
    for reg, rect in R[k].items():
        out[f'{v}/{reg}'] = {'offVsOn_r26': stat(off(v), on(v), rect), 'a53On_vs_r26On': stat(old(v), on(v), rect)}
full = ['shop-interior', 'W2', 'W4', 'W6', 'E1', 'E2', 'E3', 'E5', '20-rear-eye', '21-front-eye', 'laundry-details', 'service-corner', 'van-side']
for v in full:
    try: out[f'{v}/full'] = {'offVsOn_r26': stat(off(v), on(v)), 'a53On_vs_r26On': stat(old(v), on(v))}
    except FileNotFoundError: pass
for v in ['shop-door-eye', 'station-street', 'street-detail']: out[f'{v}/full'] = {'offVsOn_r26': stat(off(v), on(v)), 'a53On_vs_r26On': stat(old(v), on(v))}
print(json.dumps(out, indent=1, ensure_ascii=False))
json.dump(out, open(f'{d}/numbers.json', 'w'), indent=1, ensure_ascii=False)
