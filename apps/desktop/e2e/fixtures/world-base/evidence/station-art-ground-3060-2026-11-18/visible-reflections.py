import json,sys
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw

old,new,out=map(Path,sys.argv[1:4])
areas=[('art-a-street','A wet asphalt',[512,672,1000,852]),('art-b-konbini','B front glass and shop',[884,400,1324,555])]
panel=Image.new('RGB',(988,426),'#171c22');draw=ImageDraw.Draw(panel)
res={}
def levels(a):
    y=a@np.array([.2126,.7152,.0722])
    return {'pixels':int(y.size),'lumaMean':round(float(y.mean()),4),'lumaP95':float(np.percentile(y,95)),'lumaMax':float(y.max()),'allRGB250':int(np.count_nonzero(a.min(2)>=250))}
for i,(name,label,box) in enumerate(areas):
    crop=[]
    for j,path in enumerate([old,new]):
        img=Image.open(path/(name+'.png')).convert('RGB').crop(box)
        crop.append(np.asarray(img));xx=j*494+3;yy=i*214+1
        draw.text((xx,yy+4),('2a7c6f12  ' if j==0 else '2ae05c5b  ')+label,fill='white');panel.paste(img,(xx,yy+24))
    diff=np.abs(crop[0].astype('int16')-crop[1].astype('int16')).max(2)
    res[name]={'roi':box,'before':levels(crop[0]),'after':levels(crop[1]),'changed':int(np.count_nonzero(diff)),'deltaGT8':int(np.count_nonzero(diff>8))}
panel.save(out/'road-and-glass-1to1.png')
(out/'road-and-glass.json').write_text(json.dumps(res,indent=2)+'\n',encoding='utf8')
print(json.dumps(res))
