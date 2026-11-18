from io import BytesIO
import json
from pathlib import Path
import subprocess

from PIL import Image, ImageDraw

here=Path(__file__).resolve().parent
fixture=here.parents[2]
base="apps/desktop/e2e/fixtures/world-base"
compare=json.loads((here/"comparison.json").read_bytes())
names=[("nx","art-r3-board-W2"),("nz","art-r3-w1-zone-DRINK")]
sheet=Image.new("RGB",(804,458),"#242730")
draw=ImageDraw.Draw(sheet)
for j,profile in enumerate(("afternoon","evening")):
    prefix="src/"+("street-env" if profile=="afternoon" else "street-env-evening")
    for i,(face,key) in enumerate(names):
        tile=next(v for v in compare[profile]["faces"] if v["name"]==face)
        obj=next(s for s in tile["visibleCardProjections"] if s["name"]==key)
        x0,y0,x1,y1=obj["roi"]
        # Receipts use capture row 0. The atlas PNGs store that row directly.
        box=(x0-7,y0-5,x1+7,y1+5)
        f=prefix+"/"+face+".png"
        old=Image.open(BytesIO(subprocess.check_output(["git","show","2ae05c5b:"+base+"/"+f],cwd=fixture))).convert("RGB")
        new=Image.open(fixture/f).convert("RGB")
        for k,(label,image) in enumerate([("R3 + Blender",old),("R3b + Blender",new)]):
            col=(j*2+k)*201;row=i*225
            draw.text((col+5,row+5),label,fill="white")
            draw.text((col+5,row+20),profile+" / "+face+" / "+key.rsplit("-",1)[1],fill="white")
            crop=image.crop(box).resize(((box[2]-box[0])*4,(box[3]-box[1])*4),Image.Resampling.NEAREST)
            sheet.paste(crop,(col+5,row+42))
            draw.text((col+5,row+204),"4x nearest",fill="#c3cbce")
sheet.save(here/"signs-in-baked-cubes.png")
