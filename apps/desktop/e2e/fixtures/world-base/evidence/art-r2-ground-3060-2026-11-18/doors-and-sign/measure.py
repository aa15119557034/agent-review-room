import sys, json, hashlib, subprocess
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
here=Path(__file__).resolve().parent
root=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else here.parents[2]
out=Path(sys.argv[2]).resolve() if len(sys.argv)>2 else here;out.mkdir(parents=True, exist_ok=True)
evidence=root/'evidence';current=evidence/'art-r2-ground-3060-2026-11-18';old=evidence/'art-r1-ground-3060-2026-11-18';cameras=json.loads((current/'photos.json').read_text())['photos']
model=json.loads(subprocess.check_output(['node',str(here/'geometry.mjs'),str(root)]));parts=model['parts'];W,H=1440,900
def zbuffer(view,key):
    cam=cameras[view];x,y,z,w=cam['quaternion'];rot=np.array([[1-2*y*y-2*z*z,2*x*y-2*z*w,2*x*z+2*y*w],[2*x*y+2*z*w,1-2*x*x-2*z*z,2*y*z-2*x*w],[2*x*z-2*y*w,2*y*z+2*x*w,1-2*x*x-2*y*y]])
    f=H*.5/np.tan(np.radians(cam['fov'])*.5);out=np.full((H,W),np.inf)
    for b in parts[key]:
        p=(np.array(b['p']).reshape(-1,3)-cam['eye'])@rot;depth=-p[:,2];assert min(depth)>0
        px=np.array([W*.5+f*p[:,0]/depth,H*.5-f*p[:,1]/depth]).T
        for face in np.array(b['i']).reshape(-1,3):
            (a,b,c)=px[face];xmin,ymin=np.maximum(np.floor(np.min([a,b,c],axis=0)),0).astype(int);xmax,ymax=np.minimum(np.ceil(np.max([a,b,c],axis=0)),[W,H]).astype(int)
            if xmax<=xmin or ymax<=ymin:continue
            yy,xx=np.ogrid[ymin:ymax,xmin:xmax];xx=xx+.5;yy=yy+.5
            denom=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
            if abs(denom)<1e-10:continue
            wa=((b[1]-c[1])*(xx-c[0])+(c[0]-b[0])*(yy-c[1]))/denom;wb=((c[1]-a[1])*(xx-c[0])+(a[0]-c[0])*(yy-c[1]))/denom;wc=1-wa-wb
            valid=(wa>=-1e-9)&(wb>=-1e-9)&(wc>=-1e-9)
            inv=wa/depth[face[0]]+wb/depth[face[1]]+wc/depth[face[2]]
            dst=out[ymin:ymax,xmin:xmax];dst[valid]=np.minimum(dst[valid],1/inv[valid])
    return out
def maskBounds(m):
    yy,xx=np.nonzero(m)
    return [int(xx.min()),int(yy.min()),int(xx.max()+1),int(yy.max()+1)] if yy.size else []
def arr(p):return np.array(Image.open(p).convert('RGB'))
def lum(a):return .2126*a[:,:,0]+.7152*a[:,:,1]+.0722*a[:,:,2]
res={'origin':model['origin'],'B':{},'C':{},'D':{}}
c=arr(current/'art-c-alley.png');c1=arr(old/'final/C-alley.png')
pipe=np.minimum.reduce([zbuffer('art-c-alley',n) for n in parts if n.startswith(('pipe','clips','riser'))])
suggested=np.minimum.reduce([zbuffer('art-c-alley',n) for n in parts if n.startswith('suggested')])
for k in ['lamp0','lamp1','lamp2']:
    e=zbuffer('art-c-alley',k);m=np.isfinite(e);blocked=m&(pipe<e-1e-7);bright=lum(c)>180
    res['C'][k]={'bbox':maskBounds(m),'geometryPx':int(m.sum()),'pipeNearerPx':int(blocked.sum()),'remaining':int((m&~blocked).sum()),'brightL180_R1':int((m&(lum(c1)>180)).sum()),'brightL180_R2':int((m&bright).sum()),'brightColorsR1R2':{},'blockedBbox':maskBounds(blocked),'unblockedBbox':maskBounds(m&~blocked)}
    for n in parts:
      if n.startswith(('pipe','clips','riser')):res['C'][k][n]=int((m&(zbuffer('art-c-alley',n)<e-1e-7)).sum())
    res['C'][k]['brightColorsR1R2']={str(v):[int((m&(lum(im)>v)).sum()) for im in [c1,c]] for v in [128,160,200]}
    res['C'][k]['suggestedPipeNearerPx']=int((m&(suggested<e-1e-7)).sum())
d0=arr(old/'final/D-laundry.png');d1=arr(current/'art-d-laundry.png');l0,l1=lum(d0),lum(d1);diff=np.max(abs(d1.astype('int16')-d0),axis=2)
masks={n:np.isfinite(zbuffer('art-d-laundry',n)) for n in ['oldBand','newBand','panel','print','panelPrint']}
masks.update({'newBandExposed':masks['newBand']&~masks['print'],'panelExposed':masks['panel']&~masks['panelPrint'],'union':masks['newBand']|masks['panel'],'bandExtensions':masks['newBand']&~masks['oldBand']})
for label,m in masks.items():
    res['D'][label]={'pixels':int(m.sum()),'bounds':maskBounds(m),'medianLumaBeforeAfter':[round(float(np.median(a[m])),2) for a in [l0,l1]],'any':int((m&(diff>0)).sum()),'maxRGBGt8':int((m&(diff>8)).sum()),'deltaLumaGt8':int((m&(l1-l0>8)).sum()),'deltaLumaGt20':int((m&(l1-l0>20)).sum()),'deltaLumaLtMinus8':int((m&(l0-l1>8)).sum()),'thresholdPairs':{str(v):[int((m&(a>=v)).sum()) for a in [l0,l1]] for v in [96,100,120,128,140,160,180,200]}}
for f in [old/'B-konbini.png',old/'final/B-konbini.png',current/'ground-off/art-b-konbini.png',current/'art-b-konbini.png']:
 a=arr(f);res['B'][str(f.relative_to(evidence))]={'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'rgbHash':hashlib.sha256(a.tobytes()).hexdigest(),'anyDifferenceVsR2':int(((a!=arr(current/'art-b-konbini.png')).any(axis=2)).sum())}
(out/'measurement.json').write_text(json.dumps(res,indent=2)+'\n')
def typeface(size):
    for face in ['C:/Windows/Fonts/segoeui.ttf','DejaVuSans.ttf']:
        try:return ImageFont.truetype(face,size)
        except OSError:pass
    return ImageFont.load_default()

def crop_table(rows, before, after, filename):
    # Integer nearest-neighbor scaling; annotations never cover the source pixels.
    padding, heading, caption = 14, 38, 28
    column=max((box[2]-box[0])*scale for _,box,scale in rows)
    heights=[(box[3]-box[1])*scale for _,box,scale in rows]
    canvas=Image.new('RGB',(column*2+padding*3,heading+sum(h+caption+padding for h in heights)), '#20242a')
    draw=ImageDraw.Draw(canvas)
    for title,left in [('R1',padding),('R2',column+padding*2)]:
        draw.text((left,5),title,'white',font=typeface(21))
    y=heading
    for (label,box,scale),height in zip(rows,heights):
        draw.text((padding,y),f'{label}    {scale}x    [{box[0]}, {box[1]}, {box[2]}, {box[3]})','#e4e7ec',font=typeface(15))
        for data,left in [(before,padding),(after,column+padding*2)]:
            crop=Image.fromarray(data).crop(box)
            canvas.paste(crop.resize((crop.width*scale,crop.height*scale),Image.Resampling.NEAREST),(left,y+caption))
        y+=height+caption+padding
    canvas.save(out/filename)

crop_table([('Near lamp',(310,110,430,196),3),('Middle lamp',(739,319,783,354),8),('Far lamp',(849,375,878,397),12)],c1,c,'C-lamps.png')
crop_table([('Fascia',(302,204,1136,341),1)],d0,d1,'D-fascia.png')
crop_table([('Service panel',(1105,336,1255,665),2)],d0,d1,'D-panel.png')
print(json.dumps({'B':res['B'],'C':res['C'],'D':{k:{'pixels':v['pixels'],'bbox':v['bounds'],'L128':v['thresholdPairs']['128'],'median':v['medianLumaBeforeAfter'],'deltaL8':v['deltaLumaGt8'],'deltaL20':v['deltaLumaGt20']} for k,v in res['D'].items()}},indent=1))
