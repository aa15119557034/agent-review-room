import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

src, out = map(Path, sys.argv[1:3])
here = Path(__file__).parent
evidence = src / 'evidence' / 'art-r2-ground-3060-2026-11-18'
r3 = src / 'artifacts' / 'r3-ground-on-47a5c12'
if not (r3 / 'report.json').is_file():
    r3 = src / 'evidence' / 'art-r3-ground-3060-2026-11-18'
out.mkdir(parents=True, exist_ok=True)
records = []
for base, record in [(evidence,'photos.json'),(r3,'report.json' if (r3/'report.json').is_file() else 'photos.json')]:
    r=json.loads((base / record).read_text(encoding='utf8'))
    shot=r['photos']['art-b-konbini']
    fn=base/shot['file']
    digest=hashlib.sha256(fn.read_bytes()).hexdigest()
    assert digest==shot['hashes'][0]
    records.append((r['source'], shot, np.asarray(Image.open(fn).convert('RGB')), digest))
for field in ['eye','quaternion','fov','canvas','time','timeOfDay','hidden']:
    assert records[0][1][field] == records[1][1][field]
camera=records[1][1]
x,y,z,w=camera['quaternion']
rot=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
eye=np.array(camera['eye'])
f=450/np.tan(np.radians(camera['fov'])/2)
audit=json.loads((here/'r3-stock.json').read_text(encoding='utf8'))
local=np.array(audit['frame']).reshape(4,4).T
def px(pos):
    world=(local@np.array([*pos,1.0]))[:3]+[280,8,900]
    cx,cy,cz=rot.T@(world-eye)
    return [720+f*cx/-cz,450-f*cy/-cz]
zones={'SNACK':-2.65,'BAKERY':-.2,'DRINK':2.3}
def span(points):
    vals=np.array([px(p) for p in points])
    return [*np.floor(vals.min(axis=0)).astype(int).tolist(),*(np.ceil(vals.max(axis=0))+1).astype(int).tolist()]
rois={}
for zone,cx in zones.items():
    rows=[v for v in audit['rows'] if v['zone']==zone]
    corners=[[x,y,z] for v in rows for x in [v['base'][0][0],v['base'][1][0]] for y in [v['base'][0][1],v['base'][1][1]] for z in [v['base'][0][2],v['base'][1][2]]]
    rois[zone+'-stock']=span(corners)
    rois[zone+'-header']=span([[cx+i*.47,1.92+j*.17,-4.55] for i in [-1,1] for j in [-1,1]])
delta=np.abs(records[1][2].astype('int16')-records[0][2].astype('int16')).max(2)
measure={}
for name,(x0,y0,x1,y1) in rois.items():
    region=delta[y0:y1,x0:x1]
    measure[name]={'roi':[x0,y0,x1,y1],'pixels':int(region.size),'changed':int((region>0).sum()),'delta_gt8':int((region>8).sum()),'delta_gt24':int((region>24).sum())}
# One unchanged pixel scale, same coordinates across columns, labels in separate margins.
x0=min(r[0] for r in rois.values())-18; x1=max(r[2] for r in rois.values())+18
y0=min(r[1] for r in rois.values())-16; y1=max(r[3] for r in rois.values())+16
width,height=x1-x0,y1-y0
panel=Image.new('RGB',(width*2+12,height+28),'#1a1e24')
d=ImageDraw.Draw(panel)
for i,(sha,_,im,_) in enumerate(records):
    xx=i*(width+12)
    d.text((xx+4,8),('R2  ' if not i else 'R3  ')+sha[:8],fill='white')
    panel.paste(Image.fromarray(im[y0:y1,x0:x1]),(xx,28))
panel.save(out/'w1-doorway-1to1.png')
result={'sources':[{'revision':m[0],'imageSHA256':m[3]} for m in records],'frame':{k:camera[k] for k in ['eye','quaternion','fov','canvas','time','timeOfDay','hidden']},'crop':[x0,y0,x1,y1],'measure':measure}
(out/'doorway-diff.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
print(json.dumps(result,ensure_ascii=True))
