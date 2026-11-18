"""Compare existing, native 1440x900 PNGs at identical poses. No renderer or GPU required."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

here=Path(__file__).resolve().parent
parser=argparse.ArgumentParser()
parser.add_argument('--on',type=Path,default=here/'on')
parser.add_argument('--off',type=Path,default=here/'off')
parser.add_argument('--out',type=Path,default=here)
args=parser.parse_args()
args.out.mkdir(parents=True,exist_ok=True)
before=here.parent/'joint-ground-samples-2026-11-18'
read=lambda path: json.loads(path.read_text(encoding='utf8'))
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
records={k:read(v/'report.json') for k,v in [('prior',before),('on',args.on),('off',args.off)]}
samples=['sample-e-harbour','sample-f-hillside','sample-g-rail','sample-h-north','sample-f-absolute-254']
def delta(a,b):
    x=np.array(Image.open(a).convert('RGB'),dtype=np.int16)
    y=np.array(Image.open(b).convert('RGB'),dtype=np.int16)
    diff=np.abs(x-y);d=diff.max(2)
    return dict(pixels=int(d.size),any=int((d>0).sum()),rgbDeltaAbove8=int((d>8).sum()),meanAbsoluteChannelDelta=round(float(diff.mean()),4),max=int(d.max()))
def table(rows, columns, output):
    try:font=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',18)
    except OSError:font=ImageFont.load_default()
    w,h=432,270;top,cap,gap=42,26,8
    img=Image.new('RGB',(len(columns)*(w+gap)+gap,top+len(rows)*(h+cap+gap)+gap),'#20252d');draw=ImageDraw.Draw(img)
    for i,label in enumerate(columns):draw.text((gap+i*(w+gap),8),label,font=font,fill='white')
    for r,(label,files) in enumerate(rows):
        y=top+r*(cap+h+gap)
        draw.text((gap,y),label,font=font,fill='#dbe3ed')
        for i,f in enumerate(files):img.paste(Image.open(f).convert('RGB').resize((w,h),Image.Resampling.LANCZOS),(gap+i*(w+gap),y+cap))
    img.save(output,quality=94)
results={};rows=[]
for k in samples:
    files=[root/(k+'.png') for root in [before,args.off,args.on]]
    stats={key:records[key]['photos'][k] for key in ['prior','off','on']}
    for key,f in zip(['prior','off','on'],files):
        p=stats[key]
        assert sha(f)==p['hashes'][2] and p['hashes'][0]==p['hashes'][2] and p['glError']==0 and p['errors']==[] and p['weather']['seconds']==14 and p['canvas']==[1440,900]
        assert p['fov']==stats['on']['fov'] and p['eye']==stats['on']['eye'] and max(abs(a-b) for a,b in zip(p['quaternion'],stats['on']['quaternion']))<1e-12
    results[k]={'priorVsOn':delta(files[0],files[2]),'offVsOn':delta(files[1],files[2]),'priorVsOff':delta(files[0],files[1]),'distinctFrozenHashes':{group:len(set(v['hashes'])) for group,v in stats.items()},'eye':stats['on']['eye'],'eyeHeight':stats['on']['eyeHeight']}
    rows.append((k.replace('sample-',''),files))
table(rows,['Earlier joint build at 14 s','R2 ground off at 14 s','R2 ground on at 14 s'],args.out/'ground-views.jpg')
for key in ['on','off']:
    r=records[key]
    assert r['complete'] and r['exceptions']==[] and r['photos']['return-e']['hashes']==r['photos']['sample-e-harbour']['hashes']
results['weatherE']=delta(args.on/'sample-e-harbour.png',args.on/'storm-e.png')
def crop_changes(a,b,rect):
    a,b=[np.array(Image.open(p).convert('RGB').crop(rect),dtype=np.int16) for p in [a,b]]
    return {'rect':rect,'pixels':int(a.shape[0]*a.shape[1]),'rgbDeltaAbove8':int((np.abs(a-b).max(2)>8).sum())}
for label,rect in [('sky',[1030,80,1390,310]),('sea',[1260,525,1380,566])]:
    results['weatherE'][label]=crop_changes(args.on/'sample-e-harbour.png',args.on/'storm-e.png',rect)
live=records['off']['liveShore']
results['liveShore']=delta(args.off/live[0]['file'],args.off/live[1]['file'])
results['liveShore']['lake']=crop_changes(args.off/live[0]['file'],args.off/live[1]['file'],[760,515,1230,627])
for sample in live:assert sha(args.off/sample['file'])==sample['sha256']
table([('E / harbour', [args.on/'sample-e-harbour.png',args.on/'storm-e.png']),('Tarn / live rain, fixed bank eye',[args.off/live[0]['file'],args.off/live[1]['file']])],['14 s / live sample 1','54 s / live sample 2'],args.out/'weather-water.jpg')
sampleCrops=Image.new('RGB',(760,530),'#20252d')
labels=ImageDraw.Draw(sampleCrops)
for row,(label,file,rect) in enumerate([('F lower slope','sample-f-hillside.png',(35,608,400,836)),('H approach','sample-h-north.png',(97,564,462,792))]):
    for col,(mode,directory) in enumerate([('off',args.off),('on',args.on)]):
        x=col*380+8;y=row*265
        labels.text((x,y+5),label+' / '+mode+' / 1x',fill='white')
        sampleCrops.paste(Image.open(directory/file).convert('RGB').crop(rect),(x,y+25))
sampleCrops.save(args.out/'ground-crops.png')
(args.out/'comparison.json').write_text(json.dumps(results,indent=2)+'\n',encoding='utf8')
print(json.dumps(results,ensure_ascii=False))
