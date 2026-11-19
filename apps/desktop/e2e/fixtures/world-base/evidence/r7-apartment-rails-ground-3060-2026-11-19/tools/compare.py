"""Run with Python 3, Pillow and NumPy. Paths are relative to the archive."""
import gzip
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

archive = Path(__file__).resolve().parents[1]
source = archive if len(sys.argv) == 1 else Path(sys.argv[1])
packaged = (source/'photos/before').is_dir()
labels = ['A 站前主街', 'B 便利店', 'C 公寓后巷', 'D 洗衣店', 'E 港镇码头', 'F 东部山坡', 'G 铁路边', 'H 北村']
arms = ['before', 'after']
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 20)
weights = np.array([0.2126, 0.7152, 0.0722])
ref = json.loads((archive/'tools/rail-reference.json').read_text())
cameras = json.loads((source/('tools/cameras.json' if packaged else 'cameras.json')).read_text(encoding='utf-8-sig'))
views = [v['name'] for v in cameras]
report = {'views': {}, 'regions': {}, 'historical': {}}

def get_pair(key, group):
    return [Image.open((source/group/arm if packaged else source/f'{group}-{arm}')/f'{key}.png').convert('RGB') for arm in arms]

def diff(first, second):
    delta = np.abs(np.asarray(first, dtype='int16') - np.asarray(second, dtype='int16')).max(axis=-1)
    return dict(pixels=delta.size, changed=int((delta>0).sum()), over2=int((delta>2).sum()), max=int(delta.max()))

def sheet(group, rows, output):
    w, h = 520, 325
    image = Image.new('RGB',(2*w+12,36+len(rows)*(h+33)),'#181d24')
    draw = ImageDraw.Draw(image)
    for i, title in enumerate(['第六轮 · 9b0dadbd','第七轮 · eb000ad5']):
        draw.text((i*(w+12)+6,4), title, font=font, fill='white')
    for row,(name,label) in enumerate(rows):
        y=36+row*(h+33)
        for col,img in enumerate(get_pair(name,group)):
            x=col*(w+12)
            draw.text((x+5,y), label, font=font, fill='white')
            image.paste(img.resize((w,h),Image.Resampling.LANCZOS),(x,y+29))
    image.save(archive/output, quality=91,subsampling=0)

def crop(key, rect, out):
    pair = [im.crop(rect) for im in get_pair(key,'photos')]
    w,h=pair[0].size
    canvas=Image.new('RGB',(w*2+12,h+38),'#181d24')
    draw=ImageDraw.Draw(canvas)
    for i,im in enumerate(pair):
        x=i*(w+12)
        draw.text((x+5,5), ['第六轮 · 9b0dadbd','第七轮 · eb000ad5'][i],font=font,fill='white')
        canvas.paste(im,(x,38))
    canvas.save(archive/out,quality=96,subsampling=0)
    report['regions'][out]={'xyxy':rect,**diff(*pair)}

for key in views:
    pair=get_pair(key,'photos')
    assert all(im.size==(1440,900) for im in pair)
    report['views'][key]=diff(*pair)
sheet('photos',list(zip(views,labels))[:4],'ground-a-d.jpg')
sheet('photos',list(zip(views,labels))[4:],'ground-e-h.jpg')
crop(views[2],(805,0,1262,705),'c-stairs.jpg')
crop(views[3],(477,35,1400,228),'d-railings.jpg')
for title,key,rect in [('C top tread',views[2],(975,141,1010,155)),('C middle tread',views[2],(975,364,1010,371)),('C lower tread',views[2],(975,596,1010,602)),('C near fence post',views[2],(1228,307,1250,648)),('D sign lettering',views[3],(364,267,902,304)),('D shop entry',views[3],(330,371,1030,655))]:
    samples=[im.crop(rect) for im in get_pair(key,'photos')]
    report['regions'][title]={'xyxy':rect,**diff(*samples),'medianLuma':[round(float(np.median(np.asarray(im)@weights)),2) for im in samples]}
d=[np.asarray(im) for im in get_pair(views[3],'photos')]
points=np.asarray(ref['points'])
assert len(points)==34
px,py=points.T
for arm in arms:
    receipt=gzip.decompress((source/'receipts'/f'photos-{arm}.json.gz').read_bytes()) if packaged else (source/f'photos-{arm}'/'report.json').read_bytes()
    row=json.loads(receipt)['photos'][views[3]]
    assert row['eye']==ref['eye'] and row['quaternion']==ref['quaternion']
def quant(v): return np.round(np.percentile(v,[10,50,90]),2).tolist()
rails=[]
for im in d:
    rail=im[py,px]@weights
    neighbors=(im[py,px-5]@weights+im[py,px+5]@weights)/2
    rails.append({'lumaP10P50P90':quant(rail),'neighborLumaP10P50P90':quant(neighbors),
                  'absLocalContrastP10P50P90':quant(np.abs(neighbors-rail)), 'railLuma':np.round(rail,2).tolist()})
report['railSamples']={'basis':'34 historical baseline ray hits; neighbouring samples at x ± 5 px','points':points.tolist(),
                       'before':rails[0],'after':rails[1],**diff(d[0][py,px],d[1][py,px])}
legacy_dirs=[source/'legacy'/arm if packaged else source/f'legacy-{arm}' for arm in arms]
if all((folder/'legacy.json').exists() for folder in legacy_dirs):
    hist=list(json.loads((legacy_dirs[0]/'legacy.json').read_text())['views'])
    for key in hist: report['historical'][key]=diff(*get_pair(key,'legacy'))
    sheet('legacy',[(k,k) for k in hist],'legacy-comparison.jpg')
(archive/'visual-summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
