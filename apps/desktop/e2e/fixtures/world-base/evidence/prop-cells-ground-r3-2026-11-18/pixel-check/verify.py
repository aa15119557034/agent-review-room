import hashlib
import json
from pathlib import Path
from PIL import Image

folder = Path(__file__).parent
report = json.loads((folder / "report.json").read_text(encoding="utf-8"))
assert len(report["samples"]) == 12
assert report["walk"]["distance"] > 1
assert [k["trusted"] for k in report["walk"]["keys"]] == [True, True]
assert report["strictNativeExit"] == 1
full_diffs = restore_diffs = 0
for row in report["samples"]:
    a, b, restored = (row["trials"][k] for k in ("candidate", "fullInstanceBuffer", "candidateRestored"))
    assert b["triangles"] >= a["triangles"] == restored["triangles"]
    assert (a["pixelSha256"] == b["pixelSha256"]) == (row["changedPixels"]["count"] == 0)
    assert (a["pixelSha256"] == restored["pixelSha256"]) == (row["restoredChangedPixels"]["count"] == 0)
    full_diffs += row["changedPixels"]["count"]
    restore_diffs += row["restoredChangedPixels"]["count"]
    if row["changedPixels"]["count"] or row["restoredChangedPixels"]["count"]:
        pngs = []
        for label, expected in (("first", a), ("full", b), ("restore", restored)):
            image = Image.open(folder / (row["view"] + "-" + label + ".png")).convert("RGBA")
            assert image.size == (1440, 900)
            assert hashlib.sha256(image.tobytes("raw", "BGRA")).hexdigest() == expected["pixelSha256"]
            pngs.append(image)
        for image, expected in zip(pngs[1:], [row["changedPixels"], row["restoredChangedPixels"]]):
            differences = [max(abs(x - y) for x, y in zip(u, v)) for u, v in zip(pngs[0].getdata(), image.getdata()) if u != v]
            assert len(differences) == expected["count"]
            assert max(differences, default=0) == expected["max"]
assert full_diffs == 0 and restore_diffs == 2
print("Verified twelve paired draws and six source PNGs, with two one-channel one-step restoration differences.")
