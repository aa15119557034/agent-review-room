import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

here = Path(__file__).resolve().parent
old_dir = here.parents[1] / "art-r3-ground-3060-2026-11-18"
new_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else here.parent
old_rois = json.loads((old_dir / "w1" / "doorway-diff.json").read_text(encoding="utf8"))
frames = []
for directory in [old_dir, new_dir]:
    record = directory / "photos.json"
    if not record.exists():
        record = directory / "report.json"
    run = json.loads(record.read_text(encoding="utf8"))
    camera = run["photos"]["art-b-konbini"]
    file = directory / camera["file"]
    digest = hashlib.sha256(file.read_bytes()).hexdigest()
    assert camera["hashes"] == [digest] * 3
    frames.append((run["source"], camera, digest, Image.open(file).convert("RGB")))
pose = {field:frames[0][1][field] for field in old_rois["frame"]}
assert pose == old_rois["frame"] == {k:frames[1][1][k] for k in pose}
colors = [np.asarray(frame[-1]).astype(np.int16) for frame in frames]
delta = np.abs(colors[1] - colors[0]).max(axis=2)
measure = {}
for zone, item in old_rois["measure"].items():
    x0, y0, x1, y1 = item["roi"]
    region = delta[y0:y1,x0:x1]
    measure[zone] = {"roi":item["roi"], "pixels":region.size, "changed":int((region>0).sum()),
                     "delta_gt8":int((region>8).sum()), "delta_gt24":int((region>24).sum())}
crop = old_rois["crop"]
w, h = crop[2]-crop[0], crop[3]-crop[1]
overview = Image.new("RGB", (2*w+12,h+27), "#1b1e22")
draw = ImageDraw.Draw(overview)
for i, (tag, camera, sha, im) in enumerate(frames):
    xx = i*(w+12)
    draw.text((xx+6,8), ("R3  " if not i else "R3b  ")+tag[:8], fill="white")
    overview.paste(im.crop(crop), (xx,27))
overview.save(here / "w1-doorway-1to1.png")
headers = ["SNACK-header","BAKERY-header","DRINK-header"]
panel = Image.new("RGB", (2*294+10,3*137), "#1b1e22")
draw = ImageDraw.Draw(panel)
for i, name in enumerate(headers):
    for j, (tag, _, _, im) in enumerate(frames):
        xx, yy = j*304, i*137
        original = im.crop(measure[name]["roi"])
        draw.text((xx+5,yy+5),f'{"R3" if j == 0 else "R3b"} {name[:-7]}  3x nearest',fill="white")
        panel.paste(original.resize((original.width*3,original.height*3),Image.Resampling.NEAREST),(xx,yy+22))
panel.save(here / "w1-headers-3x.png")
report = {"sources":[{"revision":q[0], "imageSHA256":q[2]} for q in frames],
          "frame":pose,"crop":crop,"measure":measure}
(here / "doorway-diff.json").write_text(json.dumps(report,indent=2)+"\n", encoding="utf8")
print(json.dumps(measure))
