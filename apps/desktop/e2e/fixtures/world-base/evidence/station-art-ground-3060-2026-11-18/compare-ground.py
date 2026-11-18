import hashlib
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

base, candidate, out = map(Path,sys.argv[1:4])
out.mkdir(parents=True,exist_ok=True)
def read_report(directory):
    return json.loads(next(p for p in [directory/'report.json',directory/'photos.json'] if p.is_file()).read_text(encoding='utf8'))
a,b=read_report(base),read_report(candidate)
names=['art-a-street','art-b-konbini','art-c-alley','art-d-laundry','sample-e-harbour','sample-f-hillside','sample-g-rail','sample-h-north','return-a']
result={'baseline':a['source'],'candidate':b['source'],'size':[1440,900],'rows':{}}
images={}
for name in names:
    l,r=a['photos'][name],b['photos'][name]
    for k in ['eye','quaternion','canvas','time','islandTime','fov','hidden','timeOfDay']:
        assert l[k]==r[k],(name,k,l[k],r[k])
    assert r['errors']==[] and r['glError']==0
    decoded=[]
    for root,shot in [(base,l),(candidate,r)]:
        path=root/shot['file']
        if not path.is_file() and name=='return-a':
            # The archive deduplicates an identical return frame. Verify the actual stored SHA below.
            primary = a['photos']['art-a-street'] if root==base else b['photos']['art-a-street']
            assert primary['hashes'][-1]==shot['hashes'][-1]
            path=root/primary['file']
        assert hashlib.sha256(path.read_bytes()).hexdigest()==shot['hashes'][-1]
        im=Image.open(path).convert('RGB')
        assert im.size==(1440,900)
        decoded.append(im)
    old,new=decoded
    diff=np.max(np.abs(np.asarray(new).astype(np.int16)-np.asarray(old).astype(np.int16)),axis=2)
    ys,xs=np.where(diff>8); bounds=[int(xs.min()),int(ys.min()),int(xs.max()+1),int(ys.max()+1)] if xs.size else None
    result['rows'][name]={'before':l['hashes'][-1],'after':r['hashes'][-1],'equalPixels':int(np.count_nonzero(diff==0)),'rgbChanged':int(np.count_nonzero(diff)),'over8':int(np.count_nonzero(diff>8)),'over24':int(np.count_nonzero(diff>24)),'bboxOver8':bounds}
    images[name]=(old,new)
    if name!='return-a':
        shutil.copyfile(candidate/r['file'],out/r['file'])
for part,shots in [('station',names[:4]),('sample',names[4:8])]:
    chart=Image.new('RGB',(960,32+4*305),'#171c22');draw=ImageDraw.Draw(chart)
    draw.text((6,5),'R3 '+a['source'][:8],fill='white')
    draw.text((486,5),'Station art '+b['source'][:8],fill='white')
    for i,name in enumerate(shots):
        for j,img in enumerate(images[name]):
            chart.paste(img.resize((480,300),Image.Resampling.LANCZOS),(480*j,32+305*i))
    chart.save(out/(part+'-ground.jpg'),quality=92,subsampling=0)
for name,box,slug in [('art-a-street',(465,0,905,167),'w3-crown'),('art-d-laundry',(0,344,300,554),'laundry-poster')]:
    dims=(box[2]-box[0],box[3]-box[1]);panel=Image.new('RGB',(dims[0]*2+8,dims[1]+24),'#171c22');d=ImageDraw.Draw(panel)
    d.text((5,5),'R3 '+a['source'][:8],fill='white');d.text((dims[0]+13,5),'Station art '+b['source'][:8],fill='white')
    for i,img in enumerate(images[name]):
        panel.paste(img.crop(box),(i*(dims[0]+8),24))
    panel.save(out/(slug+'-1to1.png'))
result['nativeNetwork']=b['networkFailures'];result['nativeExceptions']=b['exceptions']
result['sameReturnA']=b['photos']['art-a-street']['hashes'][-1]==b['photos']['return-a']['hashes'][-1]
(out/'ground-diff.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
shutil.copyfile(candidate/'report.json',out/'photos.json')
print(json.dumps({k:v['over8'] for k,v in result['rows'].items()}))
