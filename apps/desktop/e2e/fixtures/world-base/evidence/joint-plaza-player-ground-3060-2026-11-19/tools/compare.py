import sys,json,hashlib
from PIL import Image,ImageDraw
import numpy as np
from pathlib import Path
ev=Path(sys.argv[1])
native=Path(sys.argv[2])
out=Path(sys.argv[3])
items=['art-a-street','art-b-konbini','art-c-alley','art-d-laundry','sample-e-harbour','sample-f-hillside','sample-g-rail','sample-h-north','storm-e']
refs=['plaza-final-ground-3060-2026-11-19']*4+['joint-r3-ground-3060-2026-11-18']*5
def pixels(path):
    return np.asarray(Image.open(path).convert('RGB'),dtype=np.int16)
def summarize(a,b):
    dist=np.abs(pixels(a)-pixels(b))
    return dict(changedPixels=int(np.any(dist>0,axis=2).sum()),maxChannel=int(dist.max()),meanAbsoluteRGB=float(dist.mean()),fractionAnyChannelOver8=float((dist.max(axis=2)>8).mean()))
res={}
for name,entry in zip(items,refs):
    current=native/(name+'.png');ref=ev/entry/(name+'.png');res[name]={'reference':entry+'/'+ref.name,**summarize(current,ref)}
res['A-return']=summarize(native/'art-a-street.png',native/'return-a.png')
res['E-storm-vs-low-cloud']=summarize(native/'sample-e-harbour.png',native/'storm-e.png')
res['lake-live-pair']=summarize(native/'live-tarn-1.png',native/'live-tarn-2.png')
out.mkdir(exist_ok=True,parents=True)
(out/'comparison.json').write_text(json.dumps(res,indent=2)+'\n',encoding='utf8')
g=Image.new('RGB',(4*340,3*239),'#132028');draw=ImageDraw.Draw(g)
rows=[(n,n[4] if n.startswith('art-') else n[7]) for n in items[:8]]+[('sample-e-harbour','E / low cloud / 14 s'),('storm-e','E / rain front / 54 s'),('live-tarn-1','Tarn / rain front / t1'),('live-tarn-2','Tarn / rain front / t2')]
for i,(name,label) in enumerate(rows):
    im=Image.open(native/(name+'.png')).convert('RGB');im.thumbnail((340,213),Image.Resampling.LANCZOS);x=i%4*340;y=i//4*239;g.paste(im,(x,y));draw.text((x+8,y+216),label.upper() if len(label)<2 else label,fill='white')
g.save(out/'ground-contact.jpg',quality=88)
for k,v in res.items():print(k,v['changedPixels'],v['maxChannel'],round(v['meanAbsoluteRGB'],3))
