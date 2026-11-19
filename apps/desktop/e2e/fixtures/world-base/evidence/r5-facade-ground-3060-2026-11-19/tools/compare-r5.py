import json, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

root = Path(sys.argv[1])
names = [v['name'] for v in json.loads((root/'cameras.json').read_text(encoding='utf-8'))]
def image(arm, name):
    return np.array(Image.open(root/('photos-'+arm)/(name+'.png')).convert('RGB'))
def luma(v):
    return v[...,0]*.2126 + v[...,1]*.7152 + v[...,2]*.0722
def stats(before, after):
    a=before.reshape(-1,3); b=after.reshape(-1,3)
    av=luma(a); bv=luma(b); diff=b.astype(np.int16)-a.astype(np.int16)
    absolute=np.abs(diff).max(axis=1)
    return {'count':len(a),'changed':int((absolute>0).sum()), 'over2':int((absolute>2).sum()),
            'max':int(absolute.max()),'meanRGBBefore':np.round(a.mean(0),3).tolist(),'meanRGBAfter':np.round(b.mean(0),3).tolist(),
            'lumaMean':[float(av.mean()),float(bv.mean())],'lumaP10':[float(np.percentile(av,10)),float(np.percentile(bv,10))],
            'lumaMedian':[float(np.median(av)),float(np.median(bv))],'lumaP90':[float(np.percentile(av,90)),float(np.percentile(bv,90))],
            'medianChange':float(np.median(bv-av)), 'p95AbsLumaChange':float(np.percentile(np.abs(bv-av),95)),
            'lumaAtLeast250':[int((av>=250).sum()),int((bv>=250).sum())]}
def texture_energy(a):
    y=luma(a)
    g=np.hypot((y[1:-1,2:]-y[1:-1,:-2])*.5,(y[2:,1:-1]-y[:-2,1:-1])*.5)
    return float(g.mean()),float(np.percentile(g,90))
metrics={}
for name in names:
    a,b=image('before',name),image('after',name)
    value={'full':stats(a,b)}
    if (root/'photos-after-off'/(name+'.png')).is_file():
        ao,bo=image('before-off',name),image('after-off',name)
        value['shadowTintOff']=stats(ao,bo)
    metrics[name]=value
regions={'C shaded plaster middle':(477,178,670,340),'C shaded plaster lower left':(307,655,551,843),'C first door panel':(20,264,175,390)}
alley='art-c-alley'
a,b=image('before',alley),image('after',alley)
for label,box in regions.items():
    x0,y0,x1,y1=box;aa=a[y0:y1,x0:x1];bb=b[y0:y1,x0:x1]
    metrics[alley].setdefault('regions',{})[label]={'box':list(box),**stats(aa,bb),'textureGradientMeanP90':[texture_energy(aa),texture_energy(bb)]}
(root/'visual-summary.json').write_text(json.dumps(metrics,ensure_ascii=False,indent=2),encoding='utf-8')
font_path='C:/Windows/Fonts/msyh.ttc'
font=ImageFont.truetype(font_path,26); small=ImageFont.truetype(font_path,21);title=ImageFont.truetype(font_path,34)
background=(26,30,35)
def sheet(views, target):
    w,h=650,406; margin=22; offset=78; line=45
    canvas=Image.new('RGB',(2*w+3*margin,offset+(h+line)*len(views)+margin),background)
    draw=ImageDraw.Draw(canvas);draw.text((margin,19),'第 4 轮 · 共享基线',font=title,fill=(229,232,237));draw.text((2*margin+w,19),'第 5 轮 · 公寓背光',font=title,fill=(229,232,237))
    for i,name in enumerate(views):
        pos=offset+i*(h+line)
        info=json.loads((root/'photos-after/report.json').read_text(encoding='utf-8'))['photos'][name]['view']['label']
        draw.text((margin,pos),info,font=small,fill=(210,217,223))
        for j,arm in enumerate(['before','after']):
            im=Image.open(root/('photos-'+arm)/(name+'.png')).convert('RGB').resize((w,h),Image.Resampling.LANCZOS)
            canvas.paste(im,(margin+j*(w+margin),pos+line))
    canvas.save(root/target,quality=92,subsampling=0)
sheet(names[:4],'ground-a-d.jpg');sheet(names[4:],'ground-e-h.jpg')
canvas=Image.new('RGB',(1440,836),background);draw=ImageDraw.Draw(canvas)
for j,arm in enumerate(['before','after']):
    x=10+j*720;im=Image.open(root/('photos-'+arm)/(alley+'.png')).convert('RGB')
    draw.text((x,8),['改前','第 5 轮'][j],font=title,fill=(232,236,239))
    canvas.paste(im.resize((700,438),Image.Resampling.LANCZOS),(x,62))
    draw.text((x,514),'同一块背光灰泥 · 原像素裁切',font=small,fill=(220,226,230))
    canvas.paste(im.crop((294,114,994,382)),(x,552))
canvas.save(root/'alley-before-after.jpg',quality=94,subsampling=0)
print({k:[v['full']['changed'],v['full']['max'],v.get('shadowTintOff',{}).get('changed')] for k,v in metrics.items()})
print({k:[v['lumaMedian'],v['meanRGBBefore'],v['meanRGBAfter']] for k,v in metrics[alley]['regions'].items()})
