"""make-veg-atlas.py —— 生成植被贴图（带 alpha）
leaf-atlas.png   1024²  叶簇卡（树冠轮廓用）
grass-atlas.png   512²  草叶卡
flower-atlas.png  512²  白/黄/粉三色小花簇（4 列 x 3 行）
所有图都是「画大 4 倍再缩」，保住抗锯齿边缘。
"""
import math, random, os
from PIL import Image, ImageDraw, ImageFilter

OUT = r'E:\agent-review-room\.tmp\blender-blocks\out\vegtex'
os.makedirs(OUT, exist_ok=True)
SS = 4  # 超采样


def leaf_poly(cx, cy, length, width, angle, curl=0.0):
    """一片叶子：两端尖、中间宽的锥形，带一点弯"""
    pts = []
    n = 14
    for i in range(n + 1):
        t = i / n
        # 宽度曲线：中间最宽
        w = math.sin(math.pi * t) ** 0.75 * width * 0.5
        bx = cx + math.cos(angle) * (t - 0.5) * length
        by = cy + math.sin(angle) * (t - 0.5) * length
        # 弯曲
        bx += math.cos(angle + math.pi / 2) * curl * math.sin(math.pi * t)
        by += math.sin(angle + math.pi / 2) * curl * math.sin(math.pi * t)
        pts.append((bx + math.cos(angle + math.pi / 2) * w, by + math.sin(angle + math.pi / 2) * w))
    for i in range(n, -1, -1):
        t = i / n
        w = math.sin(math.pi * t) ** 0.75 * width * 0.5
        bx = cx + math.cos(angle) * (t - 0.5) * length
        by = cy + math.sin(angle) * (t - 0.5) * length
        bx += math.cos(angle + math.pi / 2) * curl * math.sin(math.pi * t)
        by += math.sin(angle + math.pi / 2) * curl * math.sin(math.pi * t)
        pts.append((bx - math.cos(angle + math.pi / 2) * w, by - math.sin(angle + math.pi / 2) * w))
    return pts


def make_leaf_atlas(size=1024):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rnd = random.Random(20261121)
    # 三团叶簇，铺满整张图（卡片会随机取一块）
    clusters = [(0.18, 0.18, 0.22), (0.58, 0.14, 0.21), (0.86, 0.30, 0.20),
                (0.26, 0.62, 0.23), (0.70, 0.60, 0.24), (0.45, 0.88, 0.20),
                (0.44, 0.42, 0.22)]
    for (cx, cy, cr) in clusters:
        cx *= S; cy *= S; cr *= S
        for _ in range(120):
            a = rnd.uniform(0, 2 * math.pi)
            r = cr * math.sqrt(rnd.random())
            x = cx + math.cos(a) * r
            y = cy + math.sin(a) * r * 0.85
            ln = rnd.uniform(0.055, 0.105) * S
            wd = ln * rnd.uniform(0.34, 0.52)
            ang = rnd.uniform(0, 2 * math.pi)
            # 越靠外越亮一点（边缘受光）
            edge = min(1.0, r / cr)
            base = rnd.uniform(0.55, 0.85) + edge * 0.15
            g = int(150 * base) + rnd.randint(-12, 12)
            rr = int(88 * base) + rnd.randint(-10, 10)
            bb = int(96 * base) + rnd.randint(-10, 10)
            col = (max(0, min(255, rr)), max(0, min(255, g)), max(0, min(255, bb)), 255)
            d.polygon(leaf_poly(x, y, ln, wd, ang, rnd.uniform(-0.25, 0.25) * ln), fill=col)
    img = img.resize((size, size), Image.LANCZOS)
    # 边缘稍微虚一点，避免硬切
    img.save(os.path.join(OUT, 'leaf-atlas.png'))
    return img


def make_grass_atlas(size=512):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rnd = random.Random(7)
    for _ in range(34):
        bx = rnd.uniform(0.12, 0.88) * S
        by = S * 0.98
        h = rnd.uniform(0.45, 0.94) * S
        lean = rnd.uniform(-0.30, 0.30) * S
        w0 = rnd.uniform(0.016, 0.030) * S
        pts_l, pts_r = [], []
        n = 10
        for i in range(n + 1):
            t = i / n
            x = bx + lean * t * t
            y = by - h * t
            w = w0 * (1 - t) ** 0.8
            pts_l.append((x - w, y))
            pts_r.append((x + w, y))
        shade = rnd.uniform(0.72, 1.0)
        col = (int(78 * shade), int(140 * shade), int(62 * shade), 255)
        d.polygon(pts_l + pts_r[::-1], fill=col)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(os.path.join(OUT, 'grass-atlas.png'))
    return img


def flower(cx, cy, r, petal, col, n=5):
    pts = []
    for i in range(n * 2):
        a = 2 * math.pi * i / (n * 2)
        rr = r if i % 2 == 0 else r * 0.45
        pts.append((cx + math.cos(a) * rr, cy + math.sin(a) * rr))
    return pts, col


def make_flower_atlas(size=512):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rnd = random.Random(31)
    rows = [
        ('white', (247, 247, 238)),
        ('yellow', (247, 214, 92)),
        ('pink', (246, 168, 196)),
    ]
    for ri, (name, base) in enumerate(rows):
        for ci in range(4):
            cx = (ci + 0.5) / 4 * S
            cy = (ri + 0.5) / 3 * S
            # 茎
            d.line([(cx, cy + S * 0.12), (cx, cy + S * 0.205)], fill=(80, 130, 66, 255), width=int(S * 0.008))
            n_fl = rnd.randint(7, 12)
            for k in range(n_fl):
                a = rnd.uniform(0, 2 * math.pi)
                rr = rnd.uniform(0, S * 0.085)
                fx = cx + math.cos(a) * rr
                fy = cy + math.sin(a) * rr * 0.8
                fr = rnd.uniform(0.034, 0.058) * S
                pts, _ = flower(fx, fy, fr, 5, base)
                v = rnd.uniform(0.88, 1.0)
                col = (int(base[0] * v), int(base[1] * v), int(base[2] * v), 255)
                d.polygon(pts, fill=col)
                d.ellipse([fx - fr * 0.28, fy - fr * 0.28, fx + fr * 0.28, fy + fr * 0.28],
                          fill=(250, 210, 90, 255))
    img = img.resize((size, size), Image.LANCZOS)
    img.save(os.path.join(OUT, 'flower-atlas.png'))
    return img


leaf = make_leaf_atlas()
grass = make_grass_atlas()
fl = make_flower_atlas()

# 一张预览：把三张图拼起来（深色底，便于看 alpha 边缘）
W = 1024 + 512 + 512 + 40
H = 1024
prev = Image.new('RGB', (W, H), (34, 40, 46))
prev.paste(leaf, (0, 0), leaf)
prev.paste(grass, (1024 + 20, 0), grass)
prev.paste(fl, (1024 + 512 + 40, 0), fl)
prev.save(os.path.join(OUT, 'atlas-preview.png'))
print('OK', OUT)


