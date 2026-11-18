from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json, hashlib, shutil, sys
import numpy as np
fixture,active,control,out=map(Path,sys.argv[1:5]);out.mkdir(exist_ok=True)
(out/'ground-off').mkdir(exist_ok=True)
old=fixture/'evidence/art-r3-ground-3060-2026-11-18'
info=json.loads((old/'image-comparison.json').read_text('utf-8'))
current=json.loads((active/'report.json').read_text('utf-8'))
off=json.loads((control/'report.json').read_text('utf-8'))
assert current['complete'] and off['complete'] and current['source']==off['source']
assert current['photos']['art-a-street']['special']['enabled'] and not off['photos']['art-a-street']['special']['enabled']
jsondump=lambda file,data:file.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
names=['art-a-street','art-b-konbini','art-c-alley','art-d-laundry','sample-e-harbour','sample-f-hillside','sample-g-rail','sample-h-north']

labels=['A 主街','B 便利店','C 公寓后巷','D 洗衣店','E 港镇码头','F 东部山坡','G 铁路小路','H 北端村道']
font=ImageFont.truetype('msyh.ttc',19)
beforeReport=json.loads((old/'photos.json').read_text('utf-8'))['photos']
def metric(a,b):
    d=np.abs(a.astype(np.int16)-b.astype(np.int16)).max(-1)
    pink=lambda x:int(((x[...,0]>=160)&(x[...,0].astype(int)-x[...,1]>=30)&(x[...,2].astype(int)-x[...,1]>=10)).sum())
    luma=lambda x:float(np.median(x@np.array([.2126,.7152,.0722])))
    return {'pixels':int(d.size),'changedGt8':int((d>8).sum()),'changedAny':int((d>0).sum()),'max':int(d.max()),'pink':[pink(a),pink(b)],'medianDisplayLuma':[round(luma(a),3),round(luma(b),3)]}
def compare_canvas(images,subset,target):
    width=480;height=300
    canvas=Image.new('RGB',(3*width+24,4*(height+33)+33),'#1d2229');d=ImageDraw.Draw(canvas)
    for j,label in enumerate(['上一轮实机','本轮 · 地表规则关闭','本轮 · 正常入口']):
        d.text((8+j*(width+4),4),label,font=font,fill='#f2f3f5')
    for i in range(4):
        at=subset+i;y=33+i*(height+33)
        d.text((8,y+1),labels[at],font=font,fill='#f2f3f5')
        for k,im in enumerate(images[at]):
            canvas.paste(im.resize((width,height),Image.Resampling.LANCZOS),(8+k*(width+4),y+29))
    canvas.save(target,quality=93,subsampling=0)
images=[];res={}
for i,n in enumerate(names):
    ref=beforeReport[n]
    a=current['photos'][n];b=off['photos'][n]
    for key in ['eye','fov']: assert a[key]==b[key]==ref[key],(n,key)
    assert a['quaternion']==b['quaternion']==ref.get('quaternion',ref.get('quat')),(n,'orientation')
    assert a['view']['target']==b['view']['target']==ref['view']['target']
    paths=[old/(n+'.png'),control/(n+'.png'),active/(n+'.png')]
    plates=[Image.open(f).convert('RGB') for f in paths];images.append(plates)
    for j in (1,2):
        dest=(out/'ground-off' if j==1 else out)/(n+'.png');shutil.copyfile(paths[j],dest)
        assert hashlib.sha256(dest.read_bytes()).hexdigest()==[None,b,a][j]['hashes'][2]
    arr=list(map(np.asarray,plates));roi={}
    if i<4:
        for key,rb in info[n]['regions'].items():
            x,y,x2,y2=rb['roi'];roi[key]={'roi':[x,y,x2,y2],'previousToCurrent':metric(arr[0][y:y2,x:x2],arr[2][y:y2,x:x2]),'groundOffToOn':metric(arr[1][y:y2,x:x2],arr[2][y:y2,x:x2])}
    res[n]={'previousToCurrent':metric(arr[0],arr[2]),'groundOffToOn':metric(arr[1],arr[2]),'regions':roi}
compare_canvas(images,0,out/'ABCD.jpg');compare_canvas(images,4,out/'EFGH.jpg')
jsondump(out/'image-comparison.json',res)
shutil.copyfile(active/'report.json',out/'photos.json')
shutil.copyfile(control/'report.json',out/'ground-off'/'photos.json')
if (control/'retained-decals.json').exists(): shutil.copyfile(control/'retained-decals.json',out/'retained-decals.json')
for k,m in res.items():print(k,m['previousToCurrent']['changedGt8'],m['groundOffToOn']['changedGt8'])
