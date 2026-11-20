#!/usr/bin/env python3
"""生成共用窗户图集 512×512：白天窗格 + 傍晚亮窗两套

布局（4×4 格，每格 128×128）：
  上半 2 行 = 白天窗格（深色玻璃 + 窗框）
  下半 2 行 = 傍晚亮窗（部分窗亮，冷暖混）
每格可平铺，UV 落在格内即可。

按 C酱 的规格：亮窗只占 15–25%，冷暖混合。
"""
import random
from PIL import Image, ImageDraw

S = 512
CELL = S // 4
random.seed(20261120)

img = Image.new('RGB', (S, S), (58, 60, 66))
d = ImageDraw.Draw(img)

def frame(box, color=(34, 36, 40)):
    d.rectangle(box, outline=color, width=3)

def pane(box, color):
    d.rectangle(box, fill=color)

# ---- 上两行（0-1）：白天窗格
for gy in range(2):
    for gx in range(4):
        x0, y0 = gx * CELL, gy * CELL
        pane((x0, y0, x0 + CELL - 1, y0 + CELL - 1), (44, 48, 56))
        # 内部 2×2 分格
        for i in range(2):
            for j in range(2):
                px = x0 + 10 + i * (CELL // 2 - 6)
                py = y0 + 10 + j * (CELL // 2 - 6)
                pane((px, py, px + CELL // 2 - 22, py + CELL // 2 - 22), (58, 70, 88))
                pane((px + 3, py + 3, px + CELL // 2 - 25, py + 12), (86, 102, 122))  # 天光反射
        frame((x0 + 2, y0 + 2, x0 + CELL - 3, y0 + CELL - 3))

# ---- 下两行（2-3）：傍晚亮窗，亮窗占 22%，冷（偏青白）暖（偏橙）混
lit_cells = []
for gy in range(2, 4):
    for gx in range(4):
        x0, y0 = gx * CELL, gy * CELL
        pane((x0, y0, x0 + CELL - 1, y0 + CELL - 1), (40, 42, 50))
        for i in range(2):
            for j in range(2):
                px = x0 + 10 + i * (CELL // 2 - 6)
                py = y0 + 10 + j * (CELL // 2 - 6)
                lit = random.random() < 0.22
                if lit:
                    warm = random.random() < 0.62
                    c = (255, 206, 150) if warm else (196, 224, 236)
                    if random.random() < 0.35:
                        c = tuple(int(v * 0.78) for v in c)   # 暗一点的亮窗
                else:
                    c = (52, 58, 70)
                pane((px, py, px + CELL // 2 - 22, py + CELL // 2 - 22), c)
        frame((x0 + 2, y0 + 2, x0 + CELL - 3, y0 + CELL - 3))

img.save(r'E:\agent-review-room\.tmp\blender-blocks\window-atlas.png')
print('saved window-atlas.png', img.size)
