from pathlib import Path
import hashlib
import json
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
here=Path(__file__).resolve().parent
fixture=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else here.parents[2]
before=fixture/'evidence/art-r2-ground-3060-2026-11-18'
after=Path(sys.argv[2]).resolve() if len(sys.argv)>2 else here.parent
out=Path(sys.argv[3]).resolve() if len(sys.argv)>3 else here
read=lambda file:json.loads(file.read_text('utf-8'))
parts=read(out/'C-bins.json')
r2=read(before/'photos.json')['photos']
r3file=after/'report.json' if (after/'report.json').exists() else after/'photos.json'
r3=read(r3file)['photos']
W,H=1440,900
for view in ['art-c-alley','art-d-laundry']:
    for key in ['eye','quaternion','fov']:assert r2[view][key]==r3[view][key],(view,key)
    assert r2[view]['view']['target']==r3[view]['view']['target']
def raster(records,cam):
    x,y,z,w=cam['quaternion']
    rot=np.array([[1-2*y*y-2*z*z,2*x*y-2*z*w,2*x*z+2*y*w],[2*x*y+2*z*w,1-2*x*x-2*z*z,2*y*z-2*x*w],[2*x*z-2*y*w,2*y*z+2*x*w,1-2*x*x-2*y*y]])
    f=H/2/np.tan(np.radians(cam['fov'])/2)
    depthmap=np.full((H,W),np.inf)
    for record in records:
      for bin in record['bins']:
        xyz=(np.array(bin['p']).reshape(-1,3)-cam['eye'])@rot
        depth=-xyz[:,2];assert (depth>0).all()
        uv=np.stack([W/2+f*xyz[:,0]/depth,H/2-f*xyz[:,1]/depth],axis=1)
        for ix in np.array(bin['i']).reshape(-1,3):
            a,b,c=uv[ix];xmin,ymin=np.maximum(np.floor(uv[ix].min(0)),0).astype(int);xmax,ymax=np.minimum(np.ceil(uv[ix].max(0)),[W,H]).astype(int)
            if xmax<=xmin or ymax<=ymin:continue
            yy,xx=np.ogrid[ymin:ymax,xmin:xmax];xx=xx+.5;yy=yy+.5
            denom=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
            if abs(denom)<1e-11:continue
            wa=((b[1]-c[1])*(xx-c[0])+(c[0]-b[0])*(yy-c[1]))/denom
            wb=((c[1]-a[1])*(xx-c[0])+(a[0]-c[0])*(yy-c[1]))/denom
            wc=1-wa-wb
            hit=(wa>=-1e-9)&(wb>=-1e-9)&(wc>=-1e-9)
            inverse=wa/depth[ix[0]]+wb/depth[ix[1]]+wc/depth[ix[2]]
            region=depthmap[ymin:ymax,xmin:xmax]
            region[hit]=np.minimum(region[hit],1/inverse[hit])
    return depthmap
def load(view):
    pair=[p/(view+'.png') for p in [before,after]]
    rgb=[np.asarray(Image.open(p).convert('RGB')) for p in pair]
    assert all(a.shape==(H,W,3) for a in rgb)
    return rgb,[hashlib.sha256(p.read_bytes()).hexdigest() for p in pair]
def diff(a,b):
    d=np.abs(a.astype(np.int16)-b).max(-1)
    yy,xx=np.nonzero(d)
    return {'changed':len(xx),'changedGt8':int((d>8).sum()),'max':int(d.max()),'changedBounds':[int(xx.min()),int(yy.min()),int(xx.max()+1),int(yy.max()+1)] if len(xx) else None}
c,ch=load('art-c-alley');d,dh=load('art-d-laundry')
L=lambda a:a@np.array([.2126,.7152,.0722])
Y=list(map(L,c))
cam=r3['art-c-alley'];pipe=raster([v for v in parts.values() if v['method'] in ['box','cyl']],cam)
result={'source':read(r3file)['source'],'width':W,'height':H,'C':{'nativeSha256':ch,'sameCamera':True,'lamps':[]},'D':{'nativeSha256':dh,'sameCamera':True,'full':diff(*d)}}
for k,r in parts.items():
    if r['method']!='lamp':continue
    z=raster([r],cam);mask=np.isfinite(z);ys,xs=np.nonzero(mask)
    result['C']['lamps'].append({'id':k,'bounds':[int(xs.min()),int(ys.min()),int(xs.max()+1),int(ys.max()+1)],'maskPx':int(mask.sum()),'nearerPipeOrClipAtR3':int(np.sum(mask&(pipe<z-1e-7))),'lumaGT180':[int(np.sum(mask&(a>180))) for a in Y],'pixelChange':diff(*[x[mask][None,:,:] for x in c])['changed'],'lumaMedian':[float(np.median(a[mask])) for a in Y]})
for name,roi in [('fascia',(302,204,1136,341)),('servicePanel',(1105,336,1255,665))]:
    x,y,u,v=roi;result['D'][name]={'roi':roi,**diff(*[a[y:v,x:u] for a in d])}
def font(n):
    try:return ImageFont.truetype('segoeui.ttf',n)
    except OSError:return ImageFont.load_default()
def sheet(rows,filename,rgb):
    pad,head,caption=12,35,25
    col=max((roi[2]-roi[0])*scale for label,roi,scale in rows)
    height=head+sum(caption+(roi[3]-roi[1])*scale+pad for label,roi,scale in rows)
    canvas=Image.new('RGB',(col*2+pad*3,height),'#20242a');dr=ImageDraw.Draw(canvas)
    for i,label in enumerate(('R2','R3')):dr.text((pad+i*(col+pad),3),label,fill='white',font=font(22))
    y=head
    for label,roi,scale in rows:
        x0,y0,x1,y1=roi
        dr.text((pad,y),f'{label}   {scale}x nearest   [{x0},{y0},{x1},{y1})',fill='white',font=font(15))
        for i,a in enumerate(rgb):
            tile=Image.fromarray(a[y0:y1,x0:x1]);canvas.paste(tile.resize((tile.width*scale,tile.height*scale),Image.Resampling.NEAREST),(pad+i*(col+pad),y+caption))
        y+=caption+(y1-y0)*scale+pad
    canvas.save(out/filename)
sheet([('Near lamp',(310,110,430,196),3),('Middle lamp',(739,319,783,354),8),('Far lamp',(849,375,878,397),12)],'C-lamps-R2-R3.png',c)
(out/'photos-check.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
