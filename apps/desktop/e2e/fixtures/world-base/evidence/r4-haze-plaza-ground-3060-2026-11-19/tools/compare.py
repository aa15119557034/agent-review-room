from pathlib import Path
import sys, json, gzip, hashlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont

root=Path(sys.argv[1])
variants=['before','haze050','haze070']
labels=['Before','Distant haze 0.50','Distant haze 0.70']
views=['art-a-street','art-b-konbini','art-c-alley','art-d-laundry','sample-e-harbour','sample-f-hillside','sample-g-rail','sample-h-north']
reports={a: json.loads((root/('photos-'+a)/'report.json').read_text(encoding='utf8')) for a in variants}
assert all(r['complete'] and r['transportAudit']['payloadIntegrityClean'] for r in reports.values())
try: font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',19)
except OSError: font=ImageFont.load_default()
pairs=Image.new('RGB',(1200,5*(245+30)),(248,248,248)); draw=ImageDraw.Draw(pairs)
crop=Image.new('RGB',(1080,415),(248,248,248));cdraw=ImageDraw.Draw(crop)
panels=['art-a-street','sample-e-harbour','sample-f-hillside','sample-g-rail','sample-h-north']
summary={}
for view in views:
    images=[];arrays=[];maps=[]
    for label in variants:
        folder=root/('photos-'+label); data=(folder/(view+'.png')).read_bytes()
        row=reports[label]['photos'][view]
        assert hashlib.sha256(data).hexdigest()==row['hashes'][-1]
        assert all(row[k]==reports['before']['photos'][view][k] for k in ['eye','quaternion','fov','time','islandTime','timeOfDay','canvas'])
        arr=gzip.decompress((folder/(view+'.distance.gz')).read_bytes()); assert hashlib.sha256(arr).hexdigest()==row['depthBands']['sha256']
        maps.append(np.frombuffer(arr,np.uint8).reshape(900,1440))
        im=Image.open(folder/(view+'.png')).convert('RGB'); images.append(im);arrays.append(np.asarray(im).astype(np.int16))
    base=arrays[0];stable=(maps[0]==maps[1])&(maps[0]==maps[2]);bands=maps[0]
    stats={'equalDepthClass':int(stable.sum()),'trials':{}}
    for i,label in enumerate(variants):
        arr=arrays[i];diff=np.max(np.abs(arr-base),axis=2)
        luma=np.tensordot(arr.astype(np.float32),np.array([.2126,.7152,.0722],dtype=np.float32),axes=1)
        row={}
        regions={'whole':np.ones_like(stable),'sky':(bands==0)&stable,'nearUnder120m':(bands>0)&(bands<=2)&stable,'mid120to530m':(bands>=3)&(bands<=4)&stable,
                 'distance530to850m':(bands==5)&stable,'farOver530m':(bands>=5)&stable}
        if view=='art-a-street':
            roi=np.zeros_like(stable);roi[:410,810:]=True;regions['upperRightOver530m']=roi&(bands>=5)&stable
        for name,mask in regions.items():
            count=int(mask.sum())
            if not count: continue
            l=luma[mask];gx=np.abs(luma[:,1:]-luma[:,:-1])[mask[:,1:]&mask[:,:-1]]
            row[name]={'pixels':count,'changed':int((diff[mask]>0).sum()),'over2Levels':int((diff[mask]>2).sum()),
                'over8Levels':int((diff[mask]>8).sum()),'maxLevel':int(diff[mask].max()),
                'meanMaxChannelDelta':round(float(diff[mask].mean()),3),'lumaMean':round(float(l.mean()),3),
                'lumaStd':round(float(l.std()),3),'meanHorizontalLumaEdge':round(float(gx.mean()),3) if len(gx) else None}
        stats['trials'][label]=row
    summary[view]=stats
    if view in panels:
        y=panels.index(view)*275
        for i,(im,label) in enumerate(zip(images,labels)):
            small=im.resize((392,245),Image.Resampling.LANCZOS);pairs.paste(small,(i*400+4,y+25))
            draw.text((i*400+5,y+2),view.split('-')[1].upper()+'   '+label,fill=(24,24,24),font=font)
    if view=='art-a-street':
        for i,(im,label) in enumerate(zip(images,labels)):
            local=im.crop((820,85,1400,675)).resize((350,356),Image.Resampling.LANCZOS);crop.paste(local,(i*360+5,40))
            cdraw.text((i*360+7,10),label,fill=(24,24,24),font=font)
(root/'visual-metrics.json').write_text(json.dumps(summary,indent=2)+'\n',encoding='utf8')
pairs.save(root/'ground-triptych.jpg',quality=93,subsampling=0);crop.save(root/'street-hillside.jpg',quality=95,subsampling=0)
print(json.dumps({v:{a:t['farOver530m'] if 'farOver530m' in t else None for a,t in row['trials'].items()} for v,row in summary.items()},separators=(',',':'))[:1250])
