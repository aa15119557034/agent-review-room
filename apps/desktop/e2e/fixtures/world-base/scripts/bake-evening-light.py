#!/usr/bin/env python3
"""Re-bake the Petalwake terrain sun-shadow channel for the evening sun (#254 C19).

Writes <petalwake>/assets/terrain/light-evening.png next to the original light.png:
R = sun shadow for src/evening.json's sun (heightfield march + prop shadows, same
functions and parameters as Petalwake's tools/terrain/bake.py), G/B/A copied
unchanged from light.png. The output stays in the local, ignored checkout.

Usage: python3 scripts/bake-evening-light.py [path/to/.local/petalwake-<sha>]
Needs numpy, scipy, pillow and numba (as Petalwake's own bake does).
"""
import glob, json, math, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.dirname(HERE)
root = sys.argv[1] if len(sys.argv) > 1 else (glob.glob(os.path.join(FIXTURE, '.local', 'petalwake-*')) or [None])[0]
if not root or not os.path.isdir(os.path.join(root, 'tools', 'terrain')):
    sys.exit('Petalwake checkout not found; pass its path (the .local/petalwake-<sha> folder).')
evening = json.load(open(os.path.join(FIXTURE, 'src', 'evening.json')))
meta = json.load(open(os.path.join(root, 'assets', 'terrain', 'meta.json')))
N = int(meta['n'])

# bake.py reads N from argv and the sun from module globals; import it as a library.
sys.argv = ['bake.py', str(N), '--keep-props']
sys.path.insert(0, os.path.join(root, 'tools', 'terrain'))
import numpy as np
from PIL import Image
from scipy import ndimage
import bake

elev, az = math.radians(evening['sunElevDeg']), math.radians(evening['sunAzDeg'])
SUN = np.array([math.sin(az) * math.cos(elev), math.sin(elev), math.cos(az) * math.cos(elev)])
bake.SUN = SUN
t0 = time.time()
q = np.fromfile(os.path.join(root, 'assets', 'terrain', 'height.u16'), dtype='<u2').reshape(N, N)
h = (meta['hMin'] + q.astype(np.float32) * ((meta['hMax'] - meta['hMin']) / 65535.0)).astype(np.float32)
light = np.array(Image.open(os.path.join(root, 'assets', 'terrain', 'light.png')).convert('RGBA'))
ML = light.shape[0]
hL = h if ML == N else bake.resize_f(h, ML)
cellL = meta['world'] / ML
shadow = bake.bake_shadow(hL, cellL, SUN[0], SUN[1], SUN[2], 2600.0, 9.0)
shadow = ndimage.gaussian_filter(shadow, 1.0)
print(f'sun shadow {time.time() - t0:.1f}s')
props = json.load(open(os.path.join(root, 'assets', 'terrain', 'props.json')))
scratch_ao = np.ones_like(shadow)  # contact AO is already in G; only the shadow is re-stamped
bake.stamp_shadows(shadow, scratch_ao, h, props, ML)
print(f'prop shadows {time.time() - t0:.1f}s')
out = light.copy()
out[..., 0] = bake.to_u8(shadow)
path = os.path.join(root, 'assets', 'terrain', os.path.basename(evening['lightMap']))
Image.fromarray(out, 'RGBA').save(path, optimize=True)
print('wrote', path, 'sun', SUN.round(4).tolist())
