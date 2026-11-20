#!/usr/bin/env python3
"""通用两两比对：python compare-pair.py <dir> <aPrefix> <bPrefix> [views]"""
import sys
import os
import numpy as np
from PIL import Image

D = sys.argv[1]
A = sys.argv[2]
B = sys.argv[3]
VIEWS = sys.argv[4].split(',') if len(sys.argv) > 4 else [
    'art-a-street', 'art-b-konbini', 'art-c-alley', 'art-d-laundry',
    'sample-e-harbour', 'sample-f-hillside', 'sample-g-rail', 'sample-h-north']

print('view'.ljust(22) + 'A→B 变化率'.rjust(14) + '最大差'.rjust(8) + '变化像素'.rjust(10) + '  近白新增')
print('-' * 66)
for v in VIEWS:
    pa = os.path.join(D, f'{A}-{v}.png')
    pb = os.path.join(D, f'{B}-{v}.png')
    if not (os.path.isfile(pa) and os.path.isfile(pb)):
        print(v.ljust(22) + '缺图'); continue
    a = np.asarray(Image.open(pa).convert('RGB')).astype(np.int16)
    b = np.asarray(Image.open(pb).convert('RGB')).astype(np.int16)
    diff = np.abs(a - b).max(axis=2)
    mask = diff > 2
    nwa = (a >= 250).all(axis=2); nwb = (b >= 250).all(axis=2)
    added = int((nwb & ~nwa).sum())
    print(v.ljust(22) + f'{mask.mean()*100:>12.3f}%' + f'{diff.max():>8}' + f'{int(mask.sum()):>10}' + f'{added:>10}')
    if mask.any():
        ys, xs = np.where(mask)
        print(f'   bbox x {int(xs.min())}–{int(xs.max())}, y {int(ys.min())}–{int(ys.max())}')
        h = np.clip(diff * 8, 0, 255).astype(np.uint8)
        Image.fromarray(np.dstack([h, np.zeros_like(h), np.zeros_like(h)])).save(
            os.path.join(D, f'diffAB-{v}.png'))
