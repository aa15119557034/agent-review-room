#!/usr/bin/env python3
"""冻结时钟后的真实内容差异（排除动画相位）。"""
import numpy as np
from PIL import Image
import os

D = r'E:\agent-review-room\.tmp\x51-tools\records\shots'
VIEWS = ['art-a-street', 'art-b-konbini', 'art-c-alley', 'art-d-laundry',
         'sample-e-harbour', 'sample-f-hillside', 'sample-g-rail', 'sample-h-north']

print('view'.ljust(22) + '变化率'.rjust(10) + '最大差'.rjust(8) + '变化像素'.rjust(10))
print('-' * 50)

for v in VIEWS:
    pa = os.path.join(D, f'fzBase-{v}.png')
    pb = os.path.join(D, f'fzCand-{v}.png')
    if not (os.path.isfile(pa) and os.path.isfile(pb)):
        print(v.ljust(22) + '缺图')
        continue
    a = np.asarray(Image.open(pa).convert('RGB')).astype(np.int16)
    b = np.asarray(Image.open(pb).convert('RGB')).astype(np.int16)
    diff = np.abs(a - b).max(axis=2)
    mask = diff > 2
    print(v.ljust(22) + f'{mask.mean()*100:>9.3f}%' + f'{diff.max():>8}' + f'{int(mask.sum()):>10}')

    nw_b = (a >= 250).all(axis=2)
    nw_c = (b >= 250).all(axis=2)
    added = int((nw_c & ~nw_b).sum())
    if nw_b.sum() or nw_c.sum() or added:
        print(f'   近白: 改前 {int(nw_b.sum())} → 改后 {int(nw_c.sum())}（新增 {added}）')

    if mask.any():
        ys, xs = np.where(mask)
        print(f'   变化区域 bbox: x {int(xs.min())}–{int(xs.max())}, y {int(ys.min())}–{int(ys.max())}')
        # 存一份差异放大图
        h = np.clip(diff * 8, 0, 255).astype(np.uint8)
        Image.fromarray(np.dstack([h, np.zeros_like(h), np.zeros_like(h)])).save(
            os.path.join(D, f'difffz-{v}.png'))
