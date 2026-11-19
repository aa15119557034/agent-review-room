"""Run with Python 3, Pillow and NumPy. Paths are relative to the archive."""
import gzip
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
sys.dont_write_bytecode=True
from clipping import analyze_pair

archive = Path(__file__).resolve().parents[1]
source = archive if len(sys.argv) == 1 else Path(sys.argv[1])
packaged = (source/'photos/before').is_dir()
labels = ['A 站前主街', 'B 便利店', 'C 公寓后巷', 'D 洗衣店', 'E 港镇码头', 'F 东部山坡', 'G 铁路边', 'H 北村']
arms = ['before', 'after']
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 20)
weights = np.array([0.2126, 0.7152, 0.0722])

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
    for i, title in enumerate(['R8c · 4eb8bfa6','R9 · 4d94a1f4']):
        draw.text((i*(w+12)+6,4), title, font=font, fill='white')
    for row,(name,label) in enumerate(rows):
        y=36+row*(h+33)
        for col,img in enumerate(get_pair(name,group)):
            x=col*(w+12)
            draw.text((x+5,y), label, font=font, fill='white')
            image.paste(img.resize((w,h),Image.Resampling.LANCZOS),(x,y+29))
    image.save(archive/output, quality=91,subsampling=0)

def crop(key, rect, out, group='photos'):
    pair = [im.crop(rect) for im in get_pair(key,group)]
    w,h=pair[0].size
    canvas=Image.new('RGB',(w*2+12,h+38),'#181d24')
    draw=ImageDraw.Draw(canvas)
    for i,im in enumerate(pair):
        x=i*(w+12)
        draw.text((x+5,5), ['R8c · 4eb8bfa6','R9 · 4d94a1f4'][i],font=font,fill='white')
        canvas.paste(im,(x,38))
    canvas.save(archive/out,quality=96,subsampling=0)
    report['regions'][out]={'xyxy':rect,**diff(*pair)}

for key in views:
    pair=get_pair(key,'photos')
    assert all(im.size==(1440,900) for im in pair)
    report['views'][key]=diff(*pair)
    files=[(source/'photos'/arm if packaged else source/f'photos-{arm}')/(key+'.png') for arm in arms]
    report.setdefault('highlights',{})[key]=analyze_pair(*files)
sheet('photos',list(zip(views,labels))[:4],'ground-a-d.jpg')
sheet('photos',list(zip(views,labels))[4:],'ground-e-h.jpg')
crop(views[2],(200,65,870,590),'c-door-light.jpg')
(archive/'visual-summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
