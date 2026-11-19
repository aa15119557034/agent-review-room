"""Connected regions with channel change > 2, for original fixed A/B/G screenshots."""
import json,sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

root=Path(__file__).resolve().parents[1]
sources=list(map(Path,sys.argv[1:3])) if len(sys.argv)>1 else [root/'photos/before',root/'photos/after']
keys=['art-a-street','art-b-konbini','sample-g-rail']
report={}
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',17)
def patches(a,b):
    delta=b-a
    active=set(zip(*np.nonzero(np.max(np.abs(delta),axis=2)>2)))
    groups=[]
    while active:
        pixel=active.pop()
        queue=[pixel]
        row=[]
        while queue:
            y,x=queue.pop();row.append((y,x))
            for n in [(y-1,x),(y+1,x),(y,x-1),(y,x+1)]:
                if n in active:active.remove(n);queue.append(n)
        yy,xx=np.array(row).T
        groups.append({'size':len(row),'rect':[int(xx.min()),int(yy.min()),int(xx.max()+1),int(yy.max()+1)],
                       'medianRGBGain':np.median(delta[yy,xx],axis=0).tolist()})
    return sorted(groups,key=lambda g:(-g['size'],g['rect']))[:5]

sheet=Image.new('RGB',(652,3*229),'#161d24');draw=ImageDraw.Draw(sheet)
for i,k in enumerate(keys):
    pair=[Image.open(s/(k+'.png')).convert('RGB') for s in sources]
    comps=patches(*[np.asarray(im,dtype='int16') for im in pair]);report[k]=comps
    if not comps:continue
    x,y,x1,y1=comps[0]['rect']; w,h=160,96;cx=(x+x1)//2;cy=(y+y1)//2
    x0=max(0,min(pair[0].width-w,cx-w//2));y0=max(0,min(pair[0].height-h,cy-h//2));box=(x0,y0,x0+w,y0+h)
    for j,im in enumerate(pair):
        xx=j*328;yy=i*229
        draw.text((xx+3,yy+3),k+' · '+['R8c','R9'][j],fill='white',font=font)
        sheet.paste(im.crop(box).resize((2*w,2*h),Image.Resampling.NEAREST),(xx,yy+30))
sheet.save(root/'abg-detail.jpg',quality=95,subsampling=0)
(root/'abg-regions.json').write_text(json.dumps(report,indent=2)+'\n')
