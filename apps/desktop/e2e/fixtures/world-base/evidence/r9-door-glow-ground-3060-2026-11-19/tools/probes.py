"""Project the recorded support probes into their original camera, and sample the paired captures."""
import gzip,json,math,sys
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw,ImageFont
root=Path(__file__).resolve().parents[1]
deep='--deep' in sys.argv
folder=root/('door-glow-deep-row' if deep else 'door-glow')
report=json.loads(gzip.decompress((folder/'report.json.gz').read_bytes()))
registry=report['photos']['far-west' if deep else 'corridor-c']['special']['registry']
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',18)
def pixels(shot,point):
    x,y,z,w=shot['quaternion']
    rotation=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
        [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    cx,cy,cz=rotation.T@(np.array(point)-np.array(shot['eye']))
    width,height=shot['canvas']
    if cz>=0:return None
    pxPerUnit=height/(2*math.tan(math.radians(shot['fov']/2))*(-cz))
    xx=int(width/2+cx*pxPerUnit);yy=int(height/2-cy*pxPerUnit)
    return [xx,yy] if 1<=xx<width-1 and 1<=yy<height-1 else None
result=[]
for sample in registry['support']:
    ident=sample['lamp']['index']; key=next((n for n,v in report['photos'].items() if (v['special'].get('selectedLamp') or {}).get('index')==ident),None)
    if key is None:continue
    shot=report['photos'][key]; normal=np.array(sample['lamp']['normal']);normal=normal/np.linalg.norm(normal)
    images=[np.asarray(Image.open(folder/(key+'-'+mode+'.png')).convert('RGB'),dtype='int16') for mode in ['off','on']]
    lines=[]
    for probe in sample['samples']:
        row={'side':probe['side']}
        for kind in ['wall','floor']:
            ray=probe[kind];hit=ray['hit']
            offset=.015*normal if kind=='wall' else np.array([0,.012,0])
            point=(np.array(ray['intended'])+offset)
            xy=pixels(shot,point)
            values=[]
            if xy:
                x,y=xy
                values=[np.median(im[y-1:y+2,x-1:x+2].reshape(-1,3),axis=0).astype(int).tolist() for im in images]
            row[kind]={'intended':ray['intended'],'surface':hit,'glowPlanePoint':point.tolist(),'projectedPixel':xy,
                       'medianRGB3x3_off_on':values,'deltaRGB':(np.subtract(values[1],values[0]).tolist() if values else None),
                       'normalDot':(round(float(np.dot(hit['normal'],normal if kind=='wall' else [0,1,0])),6) if hit else None)}
        lines.append(row)
    result.append({'view':key,'lampId':ident,'worldLamp':sample['world'],'lampNormal':normal.tolist(),'samples':lines})
(root/('deep-support-probes.json' if deep else 'support-probes.json')).write_text(json.dumps(result,indent=2)+'\n')
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',16)
canvas=Image.new('RGB',(300*len(result),242),'#171c23')
for i,row in enumerate(result):
    shot=Image.open(folder/(row['view']+'-on.png')).convert('RGB')
    center=row['samples'][0]['floor']['projectedPixel'];x0,y0=center[0]-150,center[1]-100
    crop=shot.crop((x0,y0,x0+300,y0+200));draw=ImageDraw.Draw(crop)
    for probe in row['samples']:
        xy=probe['floor']['projectedPixel']
        if xy:
            x,y=xy[0]-x0,xy[1]-y0
            draw.ellipse((x-3,y-3,x+3,y+3),outline='#00eaff',width=1)
            draw.text((x-15,y+8 if abs(probe['side'])==.4 else y-23),f"{probe['side']:+.2f}",font=font,fill='#00eaff',stroke_width=1,stroke_fill='#191919')
    canvas.paste(crop,(i*300,40));ImageDraw.Draw(canvas).text((i*300+6,8),row['view']+' · #'+str(row['lampId']),font=font,fill='white')
canvas.save(root/('deep-floor-probes.jpg' if deep else 'floor-probes.jpg'),quality=95,subsampling=0)
for row in result:
    print(row['view'],row['lampId'],[(p['side'],round(p['floor']['surface']['error'],4) if p['floor']['surface'] else None,p['floor']['projectedPixel'],p['floor']['deltaRGB']) for p in row['samples']])
