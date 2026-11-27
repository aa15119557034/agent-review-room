"""make-prop-atlas.py —— 贩卖机 / 路牌贴图集
vending-atlas.png  1024x1024  左半：饮料机正面，右半：咖啡机正面
sign-atlas.png     1024x1024  2x2 四格：限速 40 / 蓝色方向牌 / 菱形警示 / 止まれ
做法：画 4 倍再缩，字体用 Windows 自带的。
"""
import argparse, math, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

parser = argparse.ArgumentParser()
parser.add_argument('--output', default=r'E:\agent-review-room\.tmp\blender-blocks\out\proptex')
parser.add_argument('--recycle-only', action='store_true')
args = parser.parse_args()
OUT = args.output
os.makedirs(OUT, exist_ok=True)
SS = 2

FONT_CANDIDATES = [
    r'C:\Windows\Fonts\msyhbd.ttc', r'C:\Windows\Fonts\msyh.ttc',
    r'C:\Windows\Fonts\simhei.ttf', r'C:\Windows\Fonts\arialbd.ttf',
    r'C:\Windows\Fonts\arial.ttf',
]


def font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def vend_body_cell(d, x0, y0, w, h, theme):
    """机身（不含商品窗）：品牌条 + 按钮列 + 投币区 + 取物口 + PUSH"""
    dark = theme["dark"]
    d.rectangle([x0, y0, x0 + w, y0 + h], fill=theme["body"])
    bh = h * 0.10
    d.rectangle([x0, y0, x0 + w, y0 + bh], fill=theme["brand"])
    f_brand = font(int(bh * 0.58))
    tw = d.textlength(theme["brandText"], font=f_brand)
    d.text((x0 + (w - tw) / 2, y0 + bh * 0.20), theme["brandText"], font=f_brand, fill=theme["brandFg"])
    # 商品窗位置留空（深色底，让窗片盖上去）
    wx0, wy0 = x0 + w * 0.07, y0 + h * 0.13
    wx1, wy1 = x0 + w * 0.93, y0 + h * 0.66
    d.rectangle([wx0, wy0, wx1, wy1], fill=theme["socket"])
    # 按钮列
    by = y0 + h * 0.70
    for i in range(4):
        bx = x0 + w * 0.10 + i * w * 0.20
        d.rounded_rectangle([bx, by, bx + w * 0.13, by + h * 0.030], radius=4, fill=theme["button"])
    # 投币区
    d.rectangle([x0 + w * 0.68, y0 + h * 0.755, x0 + w * 0.92, y0 + h * 0.85], fill=theme["panel"])
    d.rectangle([x0 + w * 0.74, y0 + h * 0.770, x0 + w * 0.86, y0 + h * 0.790], fill=dark)
    d.ellipse([x0 + w * 0.76, y0 + h * 0.800, x0 + w * 0.81, y0 + h * 0.833], fill=(200, 200, 205))
    # 取物口
    d.rectangle([x0 + w * 0.08, y0 + h * 0.885, x0 + w * 0.66, y0 + h * 0.975], fill=theme["panel"])
    d.rectangle([x0 + w * 0.11, y0 + h * 0.905, x0 + w * 0.63, y0 + h * 0.955], fill=dark)
    f_small = font(int(h * 0.018))
    d.text((x0 + w * 0.11, y0 + h * 0.978), "PUSH", font=f_small, fill=theme["brandFg"])


def vend_window_cell(d, x0, y0, w, h, theme):
    """商品窗（单独一格，接入时给这块加自发光）：3 行 x 4 列商品 + 价签 + 灯带"""
    d.rectangle([x0, y0, x0 + w, y0 + h], fill=theme["glass"])
    # 顶部灯带
    d.rectangle([x0 + w * 0.02, y0 + h * 0.02, x0 + w * 0.98, y0 + h * 0.07], fill=theme["strip"])
    rows, cols = 3, 4
    gx0, gy0 = x0 + w * 0.05, y0 + h * 0.11
    gx1, gy1 = x0 + w * 0.95, y0 + h * 0.95
    cw = (gx1 - gx0) / cols
    ch = (gy1 - gy0) / rows
    for r in range(rows):
        for c in range(cols):
            cx = gx0 + c * cw + cw * 0.5
            cy = gy0 + r * ch + ch * 0.62
            col = theme["cans"][(r * cols + c) % len(theme["cans"])]
            cwid, chei = cw * 0.40, ch * 0.50
            d.rounded_rectangle([cx - cwid / 2, cy - chei, cx + cwid / 2, cy], radius=cwid * 0.18, fill=col)
            d.rectangle([cx - cwid * 0.30, cy - chei * 0.92, cx - cwid * 0.14, cy - chei * 0.12],
                        fill=tuple(min(255, int(v * 1.35)) for v in col))
            f_p = font(int(ch * 0.14))
            pt = "¥130"
            pw2 = d.textlength(pt, font=f_p)
            d.text((cx - pw2 / 2, cy + ch * 0.04), pt, font=f_p, fill=theme["dark"])


def make_vending_atlas(size=1024):
    """2x2：左列=机身（上 DRINK / 下 COFFEE），右列=商品窗（上 DRINK / 下 COFFEE）"""
    S = size * SS
    img = Image.new("RGB", (S, S), (28, 30, 34))
    d = ImageDraw.Draw(img)
    q = S // 2
    drinks = dict(
        body=(196, 62, 58), brand=(28, 96, 172), brandText="DRINK", brandFg=(255, 255, 255),
        glass=(236, 243, 248), panel=(60, 62, 66), button=(240, 236, 210), socket=(90, 40, 38),
        strip=(255, 248, 214),
        cans=[(220, 80, 70), (80, 150, 210), (240, 200, 80), (120, 190, 120)],
        dark=(38, 40, 44),
    )
    coffee = dict(
        body=(52, 56, 62), brand=(24, 26, 30), brandText="COFFEE", brandFg=(232, 196, 120),
        glass=(240, 228, 208), panel=(30, 32, 36), button=(232, 196, 120), socket=(40, 40, 44),
        strip=(255, 226, 170),
        cans=[(120, 84, 60), (200, 170, 130), (90, 66, 50), (230, 210, 180)],
        dark=(24, 26, 30),
    )
    vend_body_cell(d, 0, 0, q, q, drinks)
    vend_window_cell(d, q, 0, q, q, drinks)
    vend_body_cell(d, 0, q, q, q, coffee)
    vend_window_cell(d, q, q, q, q, coffee)
    d.rectangle([q - 2, 0, q + 2, S], fill=(20, 20, 22))
    d.rectangle([0, q - 2, S, q + 2], fill=(20, 20, 22))
    img = img.resize((size, size), Image.LANCZOS)
    img.save(os.path.join(OUT, "vending-atlas.png"))
    return img


def sign_speed(d, box, num):
    x0, y0, w, h = box
    cx, cy, r = x0 + w / 2, y0 + h / 2, min(w, h) * 0.40
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(248, 248, 246))
    d.ellipse([cx - r * 0.86, cy - r * 0.86, cx + r * 0.86, cy + r * 0.86], outline=(198, 44, 40), width=int(r * 0.20))
    f = font(int(r * 1.05))
    tw = d.textlength(num, font=f)
    d.text((cx - tw / 2, cy - r * 0.52), num, font=f, fill=(32, 34, 38))


def sign_blue(d, box):
    x0, y0, w, h = box
    bw, bh = w * 0.86, h * 0.30
    bx, by = x0 + (w - bw) / 2, y0 + h * 0.30
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=int(bh * 0.10), fill=(22, 74, 150))
    d.rounded_rectangle([bx + 6, by + 6, bx + bw - 6, by + bh - 6], radius=int(bh * 0.08),
                        outline=(246, 246, 242), width=5)
    f = font(int(bh * 0.52))
    for i, t in enumerate(['桜ヶ丘駅', 'Sakuragaoka Sta.']):
        tw = d.textlength(t, font=f if i == 0 else font(int(bh * 0.30)))
        ff = f if i == 0 else font(int(bh * 0.30))
        d.text((bx + (bw - tw) / 2, by + bh * (0.10 + i * 0.50)), t, font=ff, fill=(246, 246, 242))
    # 箭头
    ay = by + bh * 0.5
    d.polygon([(bx + bw * 0.12, ay), (bx + bw * 0.20, ay - bh * 0.16), (bx + bw * 0.20, ay + bh * 0.16)],
              fill=(246, 246, 242))


def sign_warning(d, box):
    x0, y0, w, h = box
    cx, cy, r = x0 + w / 2, y0 + h / 2, min(w, h) * 0.36
    pts = [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]
    d.polygon(pts, fill=(246, 206, 52))
    r2 = r * 0.78
    pts2 = [(cx, cy - r2), (cx + r2, cy), (cx, cy + r2), (cx - r2, cy)]
    d.polygon(pts2, outline=(40, 40, 44), width=int(r * 0.10))
    # 中间：注意符号
    d.rectangle([cx - r * 0.07, cy - r * 0.45, cx + r * 0.07, cy + r * 0.14], fill=(30, 30, 34))
    d.ellipse([cx - r * 0.10, cy + r * 0.24, cx + r * 0.10, cy + r * 0.44], fill=(30, 30, 34))


def sign_stop(d, box):
    """日本停止牌：倒三角（尖朝下）、红铺满、细白边、白字"""
    x0, y0, w, h = box
    cx, cy = x0 + w / 2, y0 + h / 2
    r = min(w, h) * 0.44
    top_y = cy - r * 0.80
    bot_y = cy + r * 0.86
    # 细白边：外三角略大
    d.polygon([(cx - r, top_y), (cx + r, top_y), (cx, bot_y)], fill=(250, 248, 244))
    # 红底铺满（只比白边小一点，模拟细边）
    e = r * 0.045
    d.polygon([(cx - r + e * 1.6, top_y + e * 1.3), (cx + r - e * 1.6, top_y + e * 1.3), (cx, bot_y - e * 1.9)],
              fill=(198, 40, 38))
    f = font(int(r * 0.30))
    t = "止まれ"
    tw = d.textlength(t, font=f)
    d.text((cx - tw / 2, cy - r * 0.42), t, font=f, fill=(252, 252, 250))


def make_sign_atlas(size=1024):
    S = size * SS
    img = Image.new('RGB', (S, S), (150, 160, 172))
    d = ImageDraw.Draw(img)
    q = S // 2
    sign_speed(d, (0, 0, q, q), '40')
    sign_blue(d, (q, 0, q, q))
    sign_warning(d, (0, q, q, q))
    sign_stop(d, (q, q, q, q))
    img = img.resize((size, size), Image.LANCZOS)
    img.save(os.path.join(OUT, 'sign-atlas.png'))
    return img


def make_recycle_label():
    image = Image.new('RGB', (512, 184), (234, 241, 225))
    d = ImageDraw.Draw(image)
    d.rectangle((0, 0, 511, 26), fill=(53, 129, 119))
    d.rectangle((0, 138, 511, 183), fill=(53, 129, 119))
    d.line((256, 47, 256, 120), fill=(123, 160, 145), width=3)
    for x, text in [(128, 'かん'), (384, 'びん')]:
        d.text((x, 78), text, font=font(56), anchor='mm', fill=(29, 62, 65))
    d.text((256, 157), '資源回収', font=font(31), anchor='mm', fill=(245, 247, 229))
    image.save(os.path.join(OUT, 'recycle-label.png'))


make_recycle_label()
if not args.recycle_only:
    v = make_vending_atlas()
    s = make_sign_atlas()
    prev = Image.new('RGB', (1024 + 1024 + 24, 1024), (24, 26, 30))
    prev.paste(v, (0, 0)); prev.paste(s, (1048, 0))
    prev.save(os.path.join(OUT, 'prop-atlas-preview.png'))
print('OK', OUT)



