"""Paint two original monochrome spray cutouts. Vertex colours carry the scene palette."""
from math import cos, pi, sin
from pathlib import Path
from random import Random

from PIL import Image, ImageDraw


def leaf(draw, root, angle, length, width, value):
    dx, dy = cos(angle), sin(angle)
    x, y = root
    edge = []
    for side in [1, -1]:
        steps = range(9) if side == 1 else range(8, -1, -1)
        for i in steps:
            t = i / 8
            half = side * width * sin(pi * t) ** 0.82
            edge.append((x + dx * length * t - dy * half, y + dy * length * t + dx * half))
    draw.polygon(edge, fill=(value, value, value, 255))


def spray(draw, origin, twig_angle, length, broad, rng):
    dx, dy = cos(twig_angle), sin(twig_angle)
    x, y = origin
    draw.line([origin, (x + dx * length, y + dy * length)], fill=(151, 151, 151, 255), width=3)
    for index in range(1, 7):
        t = index / 8
        for side in [1, -1]:
            taper = sin(pi * t) ** .72
            arm = rng.uniform(.29, .40) * length * taper if broad else rng.uniform(.23, .35) * length * taper
            angle = twig_angle + side * rng.uniform(.57, 1.16)
            leaf(draw, (x + dx * length * t, y + dy * length * t), angle, arm,
                 arm * (rng.uniform(.25, .34) if broad else rng.uniform(.14, .19)),
                 rng.choice([196, 224, 248]))
    leaf(draw, (x + dx * length * .81, y + dy * length * .81), twig_angle, length * .19,
         length * (.064 if broad else .024), 242)


rng = Random(51261127)
size = 256
atlas = Image.new("RGBA", (size * 2, size))
draw = ImageDraw.Draw(atlas)
for offset, broad in [(0, True), (256, False)]:
    for angle, length in [(-2.24, 145), (-1.71, 157), (-1.22, 135), (-0.79, 117)]:
        spray(draw, (offset + 119 + rng.randrange(-10, 12), 203 + rng.randrange(-10, 11)),
              angle, length, broad, rng)
atlas.save(Path(__file__).with_name("foliage-sprays.png"))
