import json, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
root = Path(sys.argv[1])
views = [v['name'] for v in json.loads((root/'cameras.json').read_text(encoding='utf-8'))]
font_name = 'C:/Windows/Fonts/msyh.ttc'
large = ImageFont.truetype(font_name, 21)
small = ImageFont.truetype(font_name, 16)
def pixels(arm, view):
    return np.array(Image.open(root/('photos-'+arm)/(view+'.png')).convert('RGB'))
def stats(before, after):
    a=before.reshape(-1,3); b=after.reshape(-1,3)
    delta=(b.astype(np.int16)-a.astype(np.int16)); absolute=np.abs(delta).max(axis=1)
    luma=np.array([.2126,.7152,.0722]); v=a@luma; w=b@luma
    return dict(pixels=len(a),changed=int(np.sum(absolute>0)),over2=int(np.sum(absolute>2)),max=int(np.max(absolute)),
                medianRGB=np.round([np.median(a,axis=0),np.median(b,axis=0)],3).tolist(),
                medianLuma=np.round([np.median(v),np.median(w)],3).tolist(),
                luma250=[int(np.sum(z>=250)) for z in [v,w]],absluma90=round(float(np.percentile(np.abs(w-v),90)),3))
def compare_crop(view, box, title, fname):
    a=Image.open(root/'photos-before'/(view+'.png')).convert('RGB').crop(box)
    b=Image.open(root/'photos-after'/(view+'.png')).convert('RGB').crop(box)
    width,height=a.size; im=Image.new('RGB',(width*2+12,height+42),'#171c23'); draw=ImageDraw.Draw(im)
    for x,img,label in [(0,a,'第 5 轮'),(width+12,b,'第 6 轮')]:
        draw.text((x+7,7),label+'  ·  '+title,font=large,fill='#ecf2f3')
        im.paste(img,(x,42))
    im.save(root/fname,quality=94,subsampling=0)
names=['A 站前主街','B 便利店','C 公寓后巷','D 洗衣店','E 港镇码头','F 东部山坡','G 铁路边','H 北村']
def sheet(first,start):
    width=520;height=325;gap=12;rowH=height+35
    out=Image.new('RGB',(2*width+gap,4*rowH+35),'#171c23');d=ImageDraw.Draw(out)
    for x,tag in [(0,'改前 · 第 5 轮'),(width+gap,'改后 · 第 6 轮')]: d.text((x+8,6),tag,font=large,fill='white')
    for i,name in enumerate(first,start):
        y=34+(i-start)*rowH
        for j,arm in enumerate(['before','after']):
            x=j*(width+gap);d.text((x+8,y+4),names[i],font=small,fill='#cfd8df')
            im=Image.open(root/('photos-'+arm)/(name+'.png')).convert('RGB')
            out.paste(im.resize((width,height),Image.Resampling.LANCZOS),(x,y+30))
    return out
def fullstats(a,b):
    delta=np.abs(a.astype(np.int16)-b.astype(np.int16)).max(axis=2)
    return dict(pixels=delta.size,changed=int(np.sum(delta>0)),over2=int(np.sum(delta>2)),max=int(delta.max()))
report={'views':{},'regions':{}}
for view in views:
    a,b=(pixels(k,view) for k in ['before','after'])
    report['views'][view]=fullstats(a,b)
C='art-c-alley';D='art-d-laundry'
c0,c1=pixels('before',C),pixels('after',C)
d0,d1=pixels('before',D),pixels('after',D)
def box(a,xy): x,y,u,v=xy;return a[y:v,x:u]
regions=[('C stair-front',c0,c1,[975,141,1010,155]),('C stair-middle',c0,c1,[975,364,1010,371]),
         ('C stair-lower',c0,c1,[975,596,1010,602]),('C fence post',c0,c1,[1228,307,1250,648]),
         ('C wall bare',c0,c1,[488,215,556,376]),('C amber lamp',c0,c1,[352,146,393,165]),
         ('C first door panel',c0,c1,[22,296,172,384]),('D storefront sign lettering',d0,d1,[364,267,902,304]),
         ('D shop entrance below balcony',d0,d1,[330,371,1030,655])]
for name,a,b,region in regions: report['regions'][name]={'rect':region,**stats(box(a,region),box(b,region))}
compare_crop(C,(805,0,1262,705),'后巷钢梯与围网','stairs-before-after.jpg')
compare_crop(D,(400,40,917,223),'洗衣店二楼栏杆','laundry-railing-before-after.jpg')
sheet(views[:4],0).save(root/'ground-a-d.jpg',quality=89)
sheet(views[4:],4).save(root/'ground-e-h.jpg',quality=89)
legacy_names=['01-station-street','20-rear-eye','21-front-eye','23-service-corner','24-laundry-details']
if (root/'legacy-after'/'legacy.json').exists():
    report['legacyViews']={}
    for lname in legacy_names:
        old=np.asarray(Image.open(root/'legacy-before'/(lname+'.png')).convert('RGB'))
        new=np.asarray(Image.open(root/'legacy-after'/(lname+'.png')).convert('RGB'))
        report['legacyViews'][lname]=fullstats(old,new)
        if lname=='21-front-eye':
            rect=[15,670,600,735]
            report['legacyHedge']={'rect':rect,**fullstats(box(old,rect),box(new,rect))}
(root/'visual-summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
