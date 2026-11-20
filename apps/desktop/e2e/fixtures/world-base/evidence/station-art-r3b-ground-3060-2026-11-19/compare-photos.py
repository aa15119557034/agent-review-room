import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

root=Path(__file__).resolve().parent
folders=list(map(Path,sys.argv[1:4]))
if len(folders)!=3:
    raise ValueError("Pass native capture directories for R3b, combined-before-baking and combined-final.")
records=[]
for folder in folders:
    name="report.json" if (folder/"report.json").exists() else "photos.json"
    records.append(json.loads((folder/name).read_bytes()))
assert records[0]["source"].startswith("ffbcfa3e") and records[1]["source"].startswith("38fd2506") and records[2]["source"].startswith("eed4fb46")
images={}
sizes={}
def difference(before,after):
    arr=np.abs(np.asarray(before,dtype=np.int16)-np.asarray(after,dtype=np.int16)).max(2)
    return {"pixels":arr.size,"different":int((arr>0).sum()),"delta_gt8":int((arr>8).sum()),"delta_gt24":int((arr>24).sum()),"max":int(arr.max())}
def light(image):
    v=np.asarray(image);return {"meanLuma":float(np.mean(v@np.array([.2126,.7152,.0722]))),"nearWhite":int((v.min(2)>=250).sum())}
rois={"art-a-street":[512,672,1000,852],"art-b-konbini":[884,400,1324,555]}
mixed=Image.new("RGB",(2*488+12,2*210),"#222529")
labels=ImageDraw.Draw(mixed)
for ix,(name,shot) in enumerate(records[-1]["photos"].items()):
    originals=[]
    for src,folder in zip(records,folders):
        camera=src["photos"][name]
        for k in ("eye","quaternion","fov","canvas","hidden","time","timeOfDay"):
            assert camera[k]==shot[k]
        p=folder/camera["file"];b=p.read_bytes();sha=hashlib.sha256(b).hexdigest()
        assert camera["hashes"]==[sha]*3 and shot["canvas"]==[1440,900]
        originals.append(Image.open(p).convert("RGB"))
    sizes[name]={"baseSHA256":records[0]["photos"][name]["hashes"][-1],"beforeBakeSHA256":records[1]["photos"][name]["hashes"][-1],
                 "finalSHA256":shot["hashes"][-1],"eye":shot["eye"],"quaternion":shot["quaternion"],"fov":shot["fov"],
                 "R3bToFinal":difference(originals[0],originals[2]),"cubeOnly":difference(originals[1],originals[2])}
    if name=="return-a":
        assert sizes[name]["finalSHA256"]==sizes["art-a-street"]["finalSHA256"]
        continue
    images[name]=[originals[0],originals[2]]
    if name in rois:
        bb=rois[name];parts=[im.crop(bb) for im in originals]
        sizes[name]["reflectionROI"]={"bounds":bb,"R3bToFinal":difference(parts[0],parts[2]),"cubeOnly":difference(parts[1],parts[2]),"r3b":light(parts[0]),"final":light(parts[2])}
        y=0 if name=="art-a-street" else 210
        for j,caption in [(0,"R3b"),(2,"Combined final")]:
            x=0 if j==0 else 500;labels.text((x+4,y+7),caption+"  "+name,fill="white");mixed.paste(parts[j],(x,y+25))
    (root/shot["file"]).write_bytes((folders[-1]/shot["file"]).read_bytes())
for filename,names in [("station-ground.jpg",list(images)[:4]),("island-ground.jpg",list(images)[4:])]:
    panel=Image.new("RGB",(2*640+12,4*427),"#222529");d=ImageDraw.Draw(panel)
    for i,name in enumerate(names):
        for j,im in enumerate(images[name]):
            x,y=j*652,i*427;d.text((x+6,y+7),("R3b  ffbcfa3e" if not j else "R3b + Blender  eed4fb46")+"   "+name,fill="white")
            panel.paste(im.resize((640,400),Image.Resampling.LANCZOS),(x,y+24))
    panel.save(root/filename,quality=88,subsampling=0)
mixed.save(root/"wet-road-and-glass-1to1.png")
result={"sources":[r["source"] for r in records],"timeOfDay":"evening","clock":14,"canvas":[1440,900],"photos":sizes,
        "assetNetwork":records[-1]["packageHttp"],"nativePhotoDriverExit":0,"nativeGL":records[-1]["photos"]["art-b-konbini"]["gpu"],
        "exceptions":len(records[-1]["exceptions"]),"cdpCanceled":sum(bool(f.get("canceled")) for f in records[-1]["networkFailures"])}
(root/"photos.json").write_text(json.dumps(result,indent=2)+"\n",encoding="utf8")
print({k:(v["R3bToFinal"]["delta_gt8"],v["cubeOnly"]["delta_gt8"]) for k,v in sizes.items()})
