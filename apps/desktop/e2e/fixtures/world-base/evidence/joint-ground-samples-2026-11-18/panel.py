from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import numpy as np, json
root=Path('evidence/joint-ground-samples-2026-11-18')
old=json.loads((root/'original-254/report.json').read_text('utf8'))
new=json.loads((root/'report.json').read_text('utf8'))
keys=list(new['photos'])[:-1]
width,height=600,375
page=Image.new('RGB',(width*2+44,66+len(keys)*(height+38)+20),(247,247,245))
draw=ImageDraw.Draw(page)
fonts=[ImageFont.truetype('C:/Windows/Fonts/msyhbd.ttc',x) for x in (17,22)]
draw.text((14,8),'地面抽样  E–H',font=fonts[1],fill='#18232b')
draw.text((14,38),'#254  街区正式版',font=fonts[0],fill='#374553')
draw.text((width+28,38),'#254 + #266  地形与动态天气联验',font=fonts[0],fill='#374553')
labels=['E  拉克港码头','F  东部山麓 · 同一落脚点（1.60 米）','G  铁路北侧小路','H  北端村道','F  东部山麓 · 同一绝对机位（联合地表上方 15.38 米）']
metrics={}
for i,key in enumerate(keys):
    k0='sample-f-hillside' if key=='sample-f-absolute-254' else key
    a=Image.open(root/'original-254'/old['photos'][k0]['file']).convert('RGB')
    b=Image.open(root/new['photos'][key]['file']).convert('RGB')
    assert a.size==b.size==(1440,900)
    ya=np.asarray(a,dtype=np.float32);yb=np.asarray(b,dtype=np.float32);d=np.abs(yb-ya)
    eye=new['photos'][key]['eye']; eye0=old['photos'][k0]['eye']
    metrics[key]={'left':k0,'right':key,'sameAbsoluteEye':eye0==eye,'yEyeDelta_m':eye[1]-eye0[1],
      'quaternionMaxAbsDiff':max(abs(x-y) for x,y in zip(old['photos'][k0]['quaternion'],new['photos'][key]['quaternion'])),
      'fov':new['photos'][key]['fov'],'ground':new['photos'][key]['ground'],'eyeHeight':new['photos'][key]['eyeHeight'],
      'meanAbsoluteRGB8':float(d.mean()),'maxChannelDiffAtLeast8_pixels':int((d.max(axis=-1)>=8).sum()),'pixels':int(d.shape[0]*d.shape[1])}
    y=68+i*(height+38)
    draw.text((14,y),labels[i],font=fonts[0],fill='#243440')
    for x,im in [(14,a),(width+28,b)]: page.paste(im.resize((width,height),Image.Resampling.LANCZOS),(x,y+28))
page.save(root/'ground-side-by-side.jpg',quality=92,subsampling=0,optimize=True)
(root/'comparison.json').write_text(json.dumps(metrics,indent=2)+'\n',encoding='utf8')
print(json.dumps(metrics,indent=2))
