"""Per-pixel paired RGB analysis for the 1440 x 900 PNG captures. Usage: python clipping.py before.png after.png [out.json]."""
import json,sys
from pathlib import Path
import numpy as np
from PIL import Image

def analyze_pair(before,after,box=None):
    a=np.array(Image.open(before).convert('RGB'),dtype=np.int16)
    b=np.array(Image.open(after).convert('RGB'),dtype=np.int16)
    if a.shape!=b.shape: raise ValueError('Unequal image dimensions')
    if box:
        x0,y0,x1,y1=box;a=a[y0:y1,x0:x1];b=b[y0:y1,x0:x1]
    dif=b-a; peak=np.abs(dif).max(axis=-1); changed=peak>2
    rgb_a=a[changed];rgb_b=b[changed]
    gain=(dif @ np.array([.2126,.7152,.0722]))
    def count(a):return int(a.sum())
    def percentile(a):return np.round(np.percentile(a,[10,50,90,99]),3).tolist() if len(a) else None
    def counts(previous,current):
        return {'before':count(previous),'after':count(current),'new':count(~previous&current),'lost':count(previous&~current)}
    near=lambda m:(m>=250).all(axis=-1)
    pure=lambda m:(m==255).all(axis=-1)
    out={'pixels':int(peak.size),'changed':count(peak>0),'over2':count(changed),'maxDelta':int(peak.max()),
         'allRGB255':counts(pure(a),pure(b)), 'allRGB250':counts(near(a),near(b)),
         'perChannel255':{k:counts(a[:,:,i]==255,b[:,:,i]==255) for i,k in enumerate('RGB')},
         'lumaDeltaP10P50P90P99_over2':percentile(gain[changed]),
         'lumaGainOver5':count(gain>5),
         'medianRGBDelta_over2':np.median(rgb_b-rgb_a,axis=0).tolist() if len(rgb_a) else None}
    if box:out['rect']=box
    return out
if __name__=='__main__':
    result=analyze_pair(*sys.argv[1:3])
    if len(sys.argv)>3:Path(sys.argv[3]).write_text(json.dumps(result,indent=2)+'\n')
    else:print(json.dumps(result))
