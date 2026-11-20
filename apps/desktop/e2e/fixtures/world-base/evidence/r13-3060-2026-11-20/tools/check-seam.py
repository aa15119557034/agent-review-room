#!/usr/bin/env python3
"""B 平台接缝专项检查：强边计数 + 三条横剖面 + 放大对照图"""
import os
import numpy as np
from PIL import Image

D = r'E:\agent-review-room\.tmp\x51-tools\records\shots'
X0, X1, Y0, Y1 = 560, 600, 655, 695


def lum(p):
    a = np.asarray(Image.open(p).convert('RGB')).astype(np.float32) / 255.0
    return 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]


print('=== 接缝区域 x560-600 / y655-695 强边统计 ===')
for tag in ('r13Base', 'r13Cand'):
    L = lum(os.path.join(D, f'{tag}-art-b-konbini.png'))[Y0:Y1, X0:X1]
    gx = np.abs(np.diff(L, axis=1))
    gy = np.abs(np.diff(L, axis=0))
    g = np.sqrt(gx[:-1, :] ** 2 + gy[:, :-1] ** 2)
    strong = g > 40 / 255
    print(f'{tag:9s} 强边像素 {int(strong.sum()):4d}  占比 {strong.mean()*100:5.1f}%  最大梯度 {g.max()*255:5.0f}/255')

print()
print('=== 三条横剖面的相邻像素最大跳变（越大说明越像硬边）===')
for tag in ('r13Base', 'r13Cand'):
    L = lum(os.path.join(D, f'{tag}-art-b-konbini.png'))
    for y in (665, 675, 685):
        seg = L[y, 555:605]
        jump = np.abs(np.diff(seg)).max() * 255
        print(f'{tag:9s} y={y}: 最大相邻跳变 {jump:5.1f}/255')

# 放大对照图
box = (540, 620, 660, 740)
imgs = [Image.open(os.path.join(D, f'{t}-art-b-konbini.png')).convert('RGB').crop(box) for t in ('r13Base', 'r13Cand')]
z = 4
w, h = imgs[0].size
canvas = Image.new('RGB', (w * z * 2 + 12, h * z), (15, 15, 15))
for i, im in enumerate(imgs):
    canvas.paste(im.resize((w * z, h * z), Image.NEAREST), (i * (w * z + 12), 0))
out = os.path.join(D, 'zoom-B-seam-r13.png')
canvas.save(out)
print()
print('放大对照图:', out)
