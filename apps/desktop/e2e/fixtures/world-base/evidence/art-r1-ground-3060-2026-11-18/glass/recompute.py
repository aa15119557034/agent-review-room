import gzip,json,sys,hashlib,shutil
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
scratch=Path(sys.argv[1]).resolve()
out=Path(sys.argv[2]).resolve() if len(sys.argv)>2 else scratch
out.mkdir(parents=True,exist_ok=True)
read=lambda path:json.loads(path.read_text(encoding='utf-8'))
native=read(scratch/'result.json')
assert native['stage']=='complete' and native['exit']==0
raw=(scratch/'samples.bin.gz').read_bytes()
assert hashlib.sha256(raw).hexdigest()==native['sampleSHA256']
blobs=gzip.decompress(raw)
modes=native['packetFormat']['modes']; rect=native['capture']['rect']; W=rect[2]-rect[0]; H=rect[3]-rect[1]; N=W*H
assert len(blobs)==len(modes)*N*12
hdr={}; final={}
for idx,key in enumerate(modes):
    off=idx*N*12
    hdr[key]=np.frombuffer(blobs,dtype='<u2',count=N*4,offset=off).reshape(H,W,4)[::-1]
    final[key]=np.frombuffer(blobs,dtype=np.uint8,count=N*4,offset=off+N*8).reshape(H,W,4)[::-1,:,:3].astype(np.int16)
def rgbChanged(a,b): return np.any(hdr[a][:,:,:3]!=hdr[b][:,:,:3],axis=2)
def alpha(key): return hdr[key].view('<f2')[:,:,3].astype(np.float32)
def diff(a,b): return np.abs(final[a]-final[b]).max(axis=2)
def pixels(a): return int(np.sum(a))
def summarize(mask):
    vals={}
    for a,b in [('formal','normal'),('formal','formal-no-line'),('normal','normal-no-line'),('formal-no-line','normal-no-line'),('formal','formal-repeat'),('normal','normal-repeat')]:
        d=diff(a,b)[mask]
        vals[a+'~'+b]={'changed':pixels(d>0),'over8':pixels(d>8),'maximum':int(d.max()) if d.size else None,'meanMaxChannelDelta':round(float(d.mean()),4) if d.size else None}
    return vals
contrib=rgbChanged('formal','hidden')
stable=~rgbChanged('formal','formal-repeat')&~rgbChanged('formal','formal-final')&~rgbChanged('normal','normal-repeat')
owned=contrib&stable; maskNormBefore=(alpha('normal')>=.95)&owned
weights=np.array([.2126,.7152,.0722])
normalDark=(final['normal-no-line']-final['normal'])@weights
formalDark=(final['formal-no-line']-final['formal'])@weights
metrics=dict(rect=rect,width=W,height=H,pixels=N,
   factoryMaterial=native['capture']['material'],oldCameraNewVanSharedMaterialCompare={'newMeshCount':sum(o['newGlassTriangles']>0 for o in native['capture']['material']['owners']),'otherMeshCount':sum(o['otherGlassTriangles']>0 for o in native['capture']['material']['owners']),'mixedMeshes':sum(o['sharedBatch'] for o in native['capture']['material']['owners']),
     'newGlazingTriangles':sum(o['newGlassTriangles'] for o in native['capture']['material']['owners']),'otherGlazingTriangles':sum(o['otherGlassTriangles'] for o in native['capture']['material']['owners']),
     'hidingOnlyNewVanChangesHDRRGB':pixels(rgbChanged('formal','only-old-glazing')),'hidingOnlyOldVehiclesChangesHDRRGB':pixels(rgbChanged('formal','only-new-glazing'))},
   rgbVisibleContribution=pixels(owned),normalVsFormalHDRRGBChanged=pixels(rgbChanged('normal','formal')),normalVsFormalSceneAlphaChanged=pixels(alpha('formal')!=alpha('normal')),
   formalRepeatHDRRGBChanged=pixels(~stable),normalBlendEligibleAmongContributing=pixels(maskNormBefore),formalEligibleAmongContributing=pixels((alpha('formal')>=.95)&owned),
   actualLineDifferenceInStableContributingPixels=summarize(owned),fullRectFinalDifference=summarize(np.ones((H,W),bool)),
   actualLineDarkeningLuma={'normalOver8':pixels((normalDark>8)&owned),'formalOver8':pixels((formalDark>8)&owned)},
   c28Historical={'source':'b4f1350397fc00b1ff7320f1844788dd1d16b86e','visibleRGB':8540,'eligible':8468,'measuredDarkLinePixels':None,'measurements':'../../c28-toon-ground-3060-2026-11-18/motion/result.json'})
(out/'measurements.json').write_text(json.dumps(metrics,indent=2)+'\n',encoding='utf-8')
def naive_hdr(key):
    x=np.clip(hdr[key].view('<f2')[:,:,:3].astype(np.float32),0,1)
    return np.rint(np.where(x<=.0031308,x*12.92,1.055*x**(1/2.4)-.055)*255).astype(np.uint8)
def diagnostic(d): return np.stack([np.clip(np.asarray(d,dtype=np.int32)*4,0,255).astype('uint8')]*3,axis=2)
scale=3; cell=W*scale+18; top=42; row=H*scale+50
sheet=Image.new('RGB',(3*cell+14,top+2*row+14),'#171d25')
draw=ImageDraw.Draw(sheet)
try:
    font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',15)
except OSError:
    font=ImageFont.load_default()
draw.text((9,9),'van-side  (520, 268)-(590, 390)    |    each scene pixel shown 3x',font=font,fill='#ffffff')
for iy,rowdata in enumerate([[('HDR: formal blend',naive_hdr('formal')),('HDR: normal blend',naive_hdr('normal')),('HDR: glazing hidden',naive_hdr('hidden'))],[('Final: formal blend',final['formal'].astype(np.uint8)),('Final: normal blend',final['normal'].astype(np.uint8)),('Normal vs line-off, diff x4',diagnostic(diff('normal','normal-no-line')))] ]):
    for ix,(title,arr) in enumerate(rowdata):
        x=9+ix*cell;y=top+iy*row;draw.text((x,y),title,font=font,fill='#f3f7fb');im=Image.fromarray(arr);sheet.paste(im.resize((W*scale,H*scale),Image.Resampling.NEAREST),(x,y+24))
sheet.save(out/'van-side-glazing.png')
if out!=scratch:
 for name in ['result.json','samples.bin.gz']:
    shutil.copyfile(scratch/name,out/name)
print(json.dumps({k:metrics[k] for k in ['pixels','rgbVisibleContribution','normalVsFormalHDRRGBChanged','normalVsFormalSceneAlphaChanged','formalRepeatHDRRGBChanged','normalBlendEligibleAmongContributing','formalEligibleAmongContributing','actualLineDifferenceInStableContributingPixels','actualLineDarkeningLuma','oldCameraNewVanSharedMaterialCompare']}))
