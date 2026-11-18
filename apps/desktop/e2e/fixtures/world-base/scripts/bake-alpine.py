"""Rebuild the offline Schreckhorn–Lauteraarhorn inset. Requires Pillow and NumPy."""
from pathlib import Path
from urllib.request import urlretrieve

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'artifacts' / 'alpine'
OUTPUT = ROOT / 'src' / 'alpine'
Image.MAX_IMAGE_PIXELS = 10000 * 10000  # largest published SWISSIMAGE tile
CACHE.mkdir(parents=True, exist_ok=True)
OUTPUT.mkdir(exist_ok=True)


def tile(product, year, east, north, suffix, resolution='2'):
    item = f'{product}_{year}_{east}-{north}'
    name = f'{item}_{resolution}_2056{suffix}.tif'
    path = CACHE / name
    if not path.exists():
        urlretrieve(f'https://data.geo.admin.ch/ch.swisstopo.{product}/{item}/{name}', path)
    return Image.open(path)


# The 2 m DEM and the 10 cm ortho tiles cover the same LV95 extent, north up.
height = np.empty((1500, 2000), dtype=np.float32)
ortho = Image.new('RGB', (4000, 3000))
for east in range(2650, 2654):
    for north in range(1158, 1161):
        x, y = (east - 2650) * 500, (1160 - north) * 500
        with tile('swissalti3d', 2025, east, north, '_5728') as dem:
            height[y:y+500, x:x+500] = np.asarray(dem)
        with tile('swissimage-dop10', 2021, east, north, '', '0.1') as photo:
            # Use the COG overview nearest the output resolution.
            while photo.tell()+1 < photo.n_frames:
                level = photo.tell()
                photo.seek(level+1)
                if photo.width < 1000:
                    photo.seek(level)
                    break
            ortho.paste(photo.convert('RGB').resize((1000,1000),Image.Resampling.LANCZOS), (2*x, 2*y))

if not np.all((height > 2000) & (height < 4200)):
    raise ValueError('Invalid or missing survey elevations')
# Island cells span six survey metres. Filter before decimation.
low = Image.fromarray(height).resize((800, 600), Image.Resampling.LANCZOS)
np.rint((np.asarray(low) - 2000) * 10).astype('<u2').tofile(OUTPUT / 'relief.u16')

# Partially correct broad aerial illumination so the island sun can relight
# individual faces without baking the acquisition shadows into the material twice.
rgb = np.array(ortho, dtype=np.float32) / 255
lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
dz, dx = np.gradient(height, 2)
normal_length = np.sqrt(1 + dx*dx + dz*dz)
light = np.clip((0.40*dx - 0.59*dz + 0.70) / normal_length, 0, 1)
light = np.asarray(Image.fromarray(light).resize(ortho.size, Image.Resampling.BILINEAR))
brightness = np.clip((lum + 0.025) / (0.86 + 0.23*light), 0, 1)**1.42 * 0.9
colour = brightness[..., None] * (0.55 + 0.45 * rgb / np.maximum(lum[..., None], 0.045))
raw = Image.fromarray(np.uint8(np.clip(colour, 0, 1)*255 + 0.5))
# A guided filter keeps the broad boundary of each snow tongue while grouping
# fractured rock into painted value masses. Work on the macro layer in metres.
small = raw.resize((1000,750), Image.Resampling.LANCZOS)
guide = np.asarray(small.convert('L'),dtype=np.float32)/255
def average(field):
    # BoxBlur is linear. Encode positive fields on 16 bits in two 8-bit planes.
    q = np.uint16(np.clip(field,0,1)*65535)
    hi = Image.fromarray(np.uint8(q >> 8)).filter(ImageFilter.BoxBlur(2.8))
    lo = Image.fromarray(np.uint8(q & 255)).filter(ImageFilter.BoxBlur(2.8))
    return (np.asarray(hi,dtype=np.float32)*256+np.asarray(lo))/65535
mean = average(guide)
var = np.maximum(0,average(guide*guide)-mean*mean)
a = var/(var+0.035)
paint = average(a)*guide + average(mean*(1-a))
rgb_small = np.asarray(small,dtype=np.float32)/255
pigment = np.clip((paint[...,None]*0.70+rgb_small*0.30)*0.86 + np.array([0.078,0.083,0.093]),0,1)
macro = Image.fromarray(np.uint8(pigment*255)).resize(raw.size,Image.Resampling.BICUBIC)
Image.blend(macro,raw,0.12).resize((2500,1875),Image.Resampling.LANCZOS).save(
    OUTPUT / 'surface.jpg',quality=93,subsampling=0,optimize=True)
