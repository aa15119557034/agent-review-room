"""Verify all 12 final linear maps, installed PNGs and both native receipts without a GPU."""
import gzip
import importlib.util
import json
from pathlib import Path

import numpy as np
from PIL import Image

here=Path(__file__).resolve().parent
previous=here.parents[1]/"station-art-ground-3060-2026-11-18"/"reflections"
fixture=here.parents[2]
spec=importlib.util.spec_from_file_location("physical",previous/"verify.py")
physical=importlib.util.module_from_spec(spec)
spec.loader.exec_module(physical)
compare=json.loads((here/"comparison.json").read_bytes())
served=json.loads((here/"http-bytes.json").read_bytes())
for profile,round in compare.items():
    folder=here/profile
    directory=fixture/"src"/("street-env-evening" if profile=="evening" else "street-env")
    raw_report=gzip.decompress((folder/"bake-report.json.gz").read_bytes())
    assert physical.sha(raw_report)==round["sharedReportSHA256"]
    native=json.loads(raw_report)
    physical.geometry(native)
    assert native["bakeValid"] and native["encodingValid"] and len(native["networkFailures"])==round["canceled"]
    assert not native["unresolvedFailures"] and all(r["readerComplete"] and r["readerHTTPStatus"]==200 for r in native["verifiedCanceled"])
    for face in round["faces"]:
        name=face["name"]
        old=gzip.decompress((previous/profile/(name+".rgba16f.gz")).read_bytes())
        assert physical.sha(old)==face["prevRawSHA256"]
        file=folder/(name+".rgba16f.gz")
        new=gzip.decompress(file.read_bytes()) if file.exists() else old
        assert physical.sha(new)==face["rawSHA256"]
        code,err,count,peak=physical.color(physical.array(new))
        assert err==face["maxEncodingError"] and count==face["rawOver2"] and peak==face["peak"]
        png=directory/(name+".png")
        assert physical.sha(png.read_bytes())==face["pngSHA256"]
        assert np.array_equal(code,np.asarray(Image.open(png).convert("RGB")))
        old_code,*_=physical.color(physical.array(old))
        delta=np.abs(code.astype(int)-old_code.astype(int)).max(axis=2)
        assert int((delta>0).sum())==face["encodedChanged"] and int((delta>8).sum())==face["delta8"]
    print(profile, "6 HDRs verified", sum(r["rawOver2"] for r in round["faces"]), "raw pixels over 2")
    receipt=json.loads((here/f"upload-{profile}.json").read_bytes())
    assert receipt["source"].startswith("eed4fb46") and receipt["time"]==profile
    assert receipt["beforeGL"]==receipt["afterGL"]==receipt["extraWetPasses"]==receipt["runtimeCaptures"]==0
    assert receipt["glassCount"]==8 and receipt["allGlassShare"] and receipt["wetShares"] and sum(receipt["panes"].values())==27
    for face in receipt["faces"]:
        file=directory/(face["name"]+".png")
        assert len(face["serverRequests"])==1 and face["serverRequests"][0]["http"]==200
        body=next(x for x in served[profile] if x["face"]==face["name"])
        assert body["http"]==200 and body["bytes"]==file.stat().st_size and body["sha256"]==physical.sha(file.read_bytes())
        assert all(x["http"]==200 and x["decoded"]==body["bytes"] for x in face["requests"])
        rgba=np.asarray(Image.open(file).convert("RGBA")).tobytes()
        assert face["gpuRGBA"]==face["imageRGBA"]==physical.sha(rgba)
        assert face["differentPixels"]==face["maxChannelError"]==0 and face["framebufferStatus"]==36053
    print(profile, "6 installed PNGs match decoded images and hardware texture readback")
