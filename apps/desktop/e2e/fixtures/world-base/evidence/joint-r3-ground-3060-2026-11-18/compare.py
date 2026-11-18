import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

here = Path(__file__).resolve().parent
previous = here.parent / "joint-r2-ground-3060-2026-11-18"
read = lambda path: json.loads(path.read_text(encoding="utf-8"))
new = read(here / "report.json")
old = read(previous / "on" / "report.json")
off = read(previous / "off" / "report.json")
assert new["source"] == "8487a1c14f63b7f43316191327352c15dfd4967b" and new["complete"]
summary = {}
for name, current in new["photos"].items():
    older = old["photos"][name]
    for key in ("eye", "quaternion", "fov", "time", "islandTime", "view", "weather", "water"):
        assert current[key] == older[key], (name, key)
    current_path = here / current["file"]
    assert hashlib.sha256(current_path.read_bytes()).hexdigest() == current["hashes"][-1]
    assert current["glError"] == 0 and current["errors"] == []
    a = np.asarray(Image.open(previous / "on" / older["file"]).convert("RGB"), dtype=np.int16)
    b = np.asarray(Image.open(current_path).convert("RGB"), dtype=np.int16)
    delta = abs(a - b).max(axis=2)
    summary[name] = {"pixelsOver8": int((delta > 8).sum()), "maxDelta": int(delta.max())}

name = "sample-f-hillside"
crop = (35, 608, 400, 836)
groups = [(previous / "off", off), (previous / "on", old), (here, new)]
images = [Image.open(directory / recorded["photos"][name]["file"]).convert("RGB").crop(crop)
          for directory, recorded in groups]
colors = [np.asarray(image) for image in images]
blue = np.logical_and.reduce([(x[:, :, 2] > x[:, :, 0]) & (x[:, :, 2] > x[:, :, 1]) for x in colors])
stats = []
for rgb in colors:
    _, counts = np.unique(rgb[blue], axis=0, return_counts=True)
    stats.append({"uniqueRGB": int(counts.size), "topFiveShare": float(np.sort(counts)[-5:].sum() / blue.sum())})

font = ImageFont.truetype("msyh.ttc", 16)
plate = Image.new("RGB", (3 * 365, 257), "#20242b")
draw = ImageDraw.Draw(plate)
for i, (label, image) in enumerate(zip(["原岩纹 · 地表关", "第二轮 · 地表开", "第三轮 · 地表开"], images)):
    draw.text((365 * i + 8, 3), label, font=font, fill="white")
    plate.paste(image, (i * 365, 29))
plate.save(here / "F-rock-native.png")
result = {"source": new["source"], "frames": summary, "roi": crop,
          "commonBluePixels": int(blue.sum()), "offR2OnR2OnR3": stats}
(here / "comparison.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result))
