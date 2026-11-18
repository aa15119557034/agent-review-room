# python3 collage.py <dir> <outdir> : labelled contact sheets from shot.cjs PNGs.
import sys
from PIL import Image, ImageDraw
d, o = sys.argv[1], sys.argv[2]
def tile(v, tag, label):
    im = Image.open(f'{d}/{v}-{tag}.png').convert('RGB').resize((640, 400)); g = ImageDraw.Draw(im)
    g.rectangle([0, 0, 640, 18], fill=(0, 0, 0)); g.text((6, 3), f'{v}  {label}', fill=(255, 255, 255)); return im
def sheet(rows, name):
    w = max(len(r) for r in rows); S = Image.new('RGB', (640 * w, 400 * len(rows)), (20, 20, 20))
    for y, r in enumerate(rows):
        for x, t in enumerate(r): S.paste(t, (640 * x, 400 * y))
    S.save(f'{o}/{name}.jpg', quality=88)
trio = lambda v: [tile(v, 'n-off-r26', 'off'), tile(v, 'a53-on', 'a53236b on'), tile(v, 'n-on-r26', 'r26 on')]
sheet([trio('shop-door-eye'), trio('station-street'), trio('street-detail')], '26-outside-fill-restored')
sheet([[tile(v, 'n-off-r26', 'off'), tile(v, 'n-on-r26', 'r26 on')] for v in ['shop-interior', 'W2', 'W4', 'W6']], '26-interiors-a')
sheet([[tile(v, 'n-off-r26', 'off'), tile(v, 'n-on-r26', 'r26 on')] for v in ['E1', 'E2', 'E3', 'E5']], '26-interiors-b')
sheet([[tile(v, 'a53-on', 'a53236b on'), tile(v, 'n-on-r26', 'r26 on')] for v in ['20-rear-eye', '21-front-eye', 'laundry-details']], '26-rear-and-ground')
