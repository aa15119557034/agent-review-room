"""Reproject W1 native segment outlines into camera B; positive scan jump is the bright edge."""
import gzip,json,math
from pathlib import Path
import numpy as np
from PIL import Image
root=Path(__file__).resolve().parents[1]
shot=json.loads(gzip.decompress((root/'special/report.json.gz').read_bytes()))['photos']['shop-b']
shop=shot['special']['shop']
segments=shop['segments']
n=np.array(shop['selected']['normal']); t=np.array(shop['selected']['tangent'])
f=segments[0]
offset=np.array(shop['selected']['center'])-(np.array(f['center'])-t*(f['x0']+f['width']/2-f['totalW']/2))
u=np.array(shot['quaternion'][:3]); w=shot['quaternion'][3]
def project(p):
    a=p-shot['eye'];a=a-2*w*np.cross(u,a)+2*np.cross(u,np.cross(u,a))
    scale=450/math.tan(math.radians(shot['fov']/2))/-a[2]
    return np.array([720+scale*a[0],450-scale*a[1]])
rows=[]
off,on=[np.asarray(Image.open(root/('special/shop-b-'+tag+'.png')).convert('RGB'),dtype=float) for tag in ['off','on']]
gain=(on-off)@np.array([.2126,.7152,.0722])
for y in [660,670,680,690]:
    scan=gain[y,557:657];x=558+int(np.argmax(np.diff(scan)))
    edges=[]
    for f in segments:
        p=np.array(f['center'])+offset; p[1]=f['floor']+.012+offset[1]
        corners=[project(p+side*f['width']/2*t+depth*n) for side,depth in [(-1,f['d0']),(1,f['d0']),(1,f['d1']),(-1,f['d1'])]]
        for j,point in enumerate(corners):
            q=corners[(j+1)%4]
            if min(point[1],q[1])<=y+.5<=max(point[1],q[1]) and abs(q[1]-point[1])>1e-8:
                px=point[0]+(y+.5-point[1])*(q[0]-point[0])/(q[1]-point[1])
                edges.append((abs(px-(x+.5)),f['index'],j,round(px,3)))
    rows.append(dict(y=y,firstBrightX=x,gainAdjacent=[round(gain[y,x-1],3),round(gain[y,x],3)],nearestEdges=sorted(edges)[:2]))
(root/'special/w1-platform-edge.json').write_text(json.dumps(rows,indent=2)+'\n')
print(rows)
