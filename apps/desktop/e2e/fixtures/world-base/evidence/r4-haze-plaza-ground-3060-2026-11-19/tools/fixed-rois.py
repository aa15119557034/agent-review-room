import json,sys
from pathlib import Path
from PIL import Image
import numpy as np
root=Path(sys.argv[1])
def image(path): return np.asarray(Image.open(path).convert('RGB'),dtype=np.int16)
def metric(a,b):
    d=np.abs(a-b)
    return {'pixels':int(d.shape[0]*d.shape[1]),'changed':int(np.any(d,axis=2).sum()),'over2':int((d.max(axis=2)>2).sum()),
            'over8':int((d.max(axis=2)>8).sum()),'maxRGB':[int(i) for i in d.max(axis=(0,1))]}
result={}
for v in ['art-a-street','art-b-konbini','art-c-alley','art-d-laundry','sample-e-harbour','sample-f-hillside','sample-g-rail','sample-h-north']:
    old=image(root/'photos-before'/(v+'.png'));new=image(root/'photos-haze050'/(v+'.png'))
    result[v]={'full':metric(old,new)}
    if v=='art-a-street':
        for k,(x0,y0,x1,y1) in {'gateText':(618,294,872,320),'roadAndMarkings':(430,710,840,890)}.items():
            result[v][k]={'rect':[x0,y0,x1,y1],**metric(old[y0:y1,x0:x1],new[y0:y1,x0:x1])}
for v in ['01-station-street','20-rear-eye','21-front-eye','23-service-corner','24-laundry-details']:
    old=image(root/'legacy-before'/(v+'.png'));new=image(root/'legacy-final'/(v+'.png'));result[v]={'full':metric(old,new)}
(root/'rois.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
print(json.dumps(result['art-a-street']))
