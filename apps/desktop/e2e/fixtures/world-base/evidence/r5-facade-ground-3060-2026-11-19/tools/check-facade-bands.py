import json, sys
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import binary_erosion

root=Path(sys.argv[1])
views=[v['name'] for v in json.loads((root/'cameras.json').read_text(encoding='utf-8'))]
def light(rgb):
    return .2126*rgb[...,0]+.7152*rgb[...,1]+.0722*rgb[...,2]
def summarize(a,b,mask):
    x=a[mask];y=b[mask]
    if len(x)==0: return {'pixels':0}
    ax,bx=light(x),light(y);delta=bx-ax;rgb=np.abs(y.astype(np.int16)-x.astype(np.int16)).max(axis=1)
    return {'pixels':len(x),'lumaMedian':[round(float(np.median(ax)),3),round(float(np.median(bx)),3)],
            'meanDelta':round(float(np.mean(delta)),4),'p95AbsDelta':round(float(np.percentile(abs(delta),95)),3),
            'changed':int((rgb>0).sum()),'over2':int((rgb>2).sum()),'maxByteDelta':int(rgb.max())}
summary={}
for name in views:
    mask=np.array(Image.open(root/'shading-masks'/(name+'.facade.png')).convert('RGBA'))
    ids=np.unique(mask[:,:,0][mask[:,:,3]>0]).tolist()
    a=np.array(Image.open(root/'photos-before'/(name+'.png')).convert('RGB'))
    b=np.array(Image.open(root/'photos-after'/(name+'.png')).convert('RGB'))
    visible=(mask[:,:,3]==255)&np.isin(mask[:,:,0],[32,96,160,224])
    valid=binary_erosion(visible,iterations=2)
    groups={'full shadow':binary_erosion(visible&(mask[:,:,1]<=9),iterations=2),
           'full sun':binary_erosion(visible&(mask[:,:,1]>=129),iterations=2),'all visible interiors':valid}
    summary[name]={'ids':ids,'pixels':int(visible.sum()),'groups':{k:summarize(a,b,v) for k,v in groups.items()}}
(root/'directional-light.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
for k,v in summary.items(): print(k,v['ids'],v['pixels'],v['groups']['full shadow'],v['groups']['full sun'])
