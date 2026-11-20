#!/usr/bin/env python3
"""立面模块专用 1024² 图集（C酱 规格第 3 条）

8×8 格，每格 128×128。分四组，每组白天/傍晚各一套：
  行 0-1：窗户（带窗框，白天）      行 2-3：同左，傍晚亮窗
  行 4  ：卷帘门（白天）            行 5：卷帘门（傍晚）
  行 6  ：雨棚条纹                  行 7：空调外机正面
"""
from PIL import Image, ImageDraw
import random

S = 1024
CELL = S // 8
random.seed(1120)

img = Image.new('RGB', (S, S), (70, 70, 76))
d = ImageDraw.Draw(img)


def draw_window(x0, y0, lit=False, warm=True):
    d.rectangle((x0, y0, x0 + CELL - 1, y0 + CELL - 1), fill=(46, 48, 54))       # 墙底色
    # 窗框（外框深、内侧浅）
    d.rectangle((x0 + 10, y0 + 14, x0 + CELL - 11, y0 + CELL - 15), outline=(92, 92, 98), width=5)
    d.rectangle((x0 + 16, y0 + 20, x0 + CELL - 17, y0 + CELL - 21), outline=(58, 58, 64), width=3)
    # 玻璃
    gx0, gy0 = x0 + 19, y0 + 23
    gx1, gy1 = x0 + CELL - 20, y0 + CELL - 24
    if lit:
        c = (255, 208, 152) if warm else (198, 226, 238)
        d.rectangle((gx0, gy0, gx1, gy1), fill=c)
    else:
        d.rectangle((gx0, gy0, gx1, gy1), fill=(64, 76, 92))
        d.rectangle((gx0 + 2, gy0 + 2, gx1 - 2, gy0 + 22), fill=(96, 112, 132))  # 天光
    # 中竖梃
    mx = (gx0 + gx1) // 2
    d.rectangle((mx - 2, gy0, mx + 2, gy1), fill=(72, 72, 78))
    # 窗台
    d.rectangle((x0 + 8, y1 := y0 + CELL - 15, x0 + CELL - 9, y1 + 8), fill=(104, 102, 96))


def draw_shutter(x0, y0, lit=False):
    d.rectangle((x0, y0, x0 + CELL - 1, y0 + CELL - 1), fill=(46, 48, 54))
    d.rectangle((x0 + 8, y0 + 16, x0 + CELL - 9, y0 + CELL - 14), fill=(112, 116, 122))
    for k in range(0, CELL - 34, 7):
        y = y0 + 20 + k
        d.rectangle((x0 + 10, y, x0 + CELL - 11, y + 3), fill=(96, 100, 107))
    d.rectangle((x0 + 8, y0 + 16, x0 + CELL - 9, y0 + 22), fill=(134, 138, 144))


def draw_canopy(x0, y0):
    for k in range(0, CELL, 24):
        c = (196, 96, 74) if (k // 24) % 2 == 0 else (226, 214, 198)
        d.rectangle((x0, y0 + k, x0 + CELL - 1, y0 + min(k + 24, CELL) - 1), fill=c)


def draw_ac(x0, y0):
    d.rectangle((x0, y0, x0 + CELL - 1, y0 + CELL - 1), fill=(136, 138, 140))
    d.rectangle((x0 + 6, y0 + 6, x0 + CELL - 7, y0 + CELL - 7), fill=(150, 152, 154))
    # 风扇圈
    cx, cy, r = x0 + CELL // 2, y0 + CELL // 2, CELL // 3
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(110, 112, 114), width=4)
    for a in range(0, 360, 60):
        d.line((cx, cy, cx + int(r * 0.8 * __import__('math').cos(__import__('math').radians(a))),
                cy + int(r * 0.8 * __import__('math').sin(__import__('math').radians(a)))), fill=(118, 120, 122), width=3)


# 行 0-1：白天窗（8 个，其中一个偏暖玻璃）
for gy in (0, 1):
    for gx in range(8):
        draw_window(gx * CELL, gy * CELL, lit=False)
# 行 2-3：傍晚亮窗（22% 亮）
for gy in (2, 3):
    for gx in range(8):
        draw_window(gx * CELL, gy * CELL, lit=random.random() < 0.22, warm=random.random() < 0.62)
# 行 4-5：卷帘门
for gy in (4, 5):
    for gx in range(8):
        draw_shutter(gx * CELL, gy * CELL, lit=(gy == 5))
# 行 6：雨棚条纹
for gx in range(8):
    draw_canopy(gx * CELL, 6 * CELL)
# 行 7：空调外机
for gx in range(8):
    draw_ac(gx * CELL, 7 * CELL)

img.save(r'E:\agent-review-room\.tmp\blender-blocks\facade-atlas.png')
print('saved facade-atlas.png', img.size)
