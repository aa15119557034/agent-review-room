"""Compare registered native PNGs; input is the sibling capture directory."""
import sys
sys.dont_write_bytecode=True
import gzip, hashlib, json, shutil
from pathlib import Path
from PIL import Image, ImageDraw
from clipping import analyze_pair

archive=Path(__file__).resolve().parents[1]
raw=archive.parent.parent/'x51-r10b-evidence'
old=raw.parent/'x51-r9-evidence'
out=archive/'special'
out.mkdir(parents=True,exist_ok=True)
def read(p):return json.loads(p.read_bytes())
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def same_eye(a,b):
    return all(a[k]==b[k] for k in ('eye','quaternion','fov','canvas','time','islandTime'))
def sheet(name,items):
    final=Image.new('RGB',(600*len(items),406),'white')
    pen=ImageDraw.Draw(final)
    for i,(title,path) in enumerate(items):
        with Image.open(path) as im:final.paste(im.convert('RGB').resize((600,375),Image.Resampling.LANCZOS),(600*i,28))
        pen.text((600*i+6,7),title,fill='black')
    final.save(out/(name+'.jpg'),quality=91)
def receipt(path,dest):
    dest.write_bytes(gzip.compress(path.read_bytes(),mtime=0))
ground=read(old/'photos-after/report.json')['photos']
oldprobe=read(old/'door-glow/report.json')['photos']['far-east']
special=raw/'shop-spill'
report=read(special/'report.json')
receipt(special/'report.json',out/'report.json.gz')
shutil.copyfile(special/'verification.json',out/'verification.json')
rows={}
for key,shot in report['photos'].items():
    paths=[special/(key+'-'+x+'.png') for x in ['off','on','repeat-on']]
    assert [digest(p) for p in paths]==shot['hashes'] and shot['hashes'][1]==shot['hashes'][2]
    for p in paths:shutil.copyfile(p,out/p.name)
    base=None
    if key=='probe-84':
        assert same_eye(oldprobe,shot)
        base=old/'door-glow/far-east-on.png'
        assert digest(base)==oldprobe['hashes'][1]
        receipt(old/'door-glow/report.json',out/'r9-far-east-receipt.json.gz')
    elif key in ('shop-b','laundry-d'):
        view={'shop-b':'art-b-konbini','laundry-d':'art-d-laundry'}[key]
        assert same_eye(ground[view],shot)
        base=old/'photos-after'/(view+'.png')
        assert digest(base)==ground[view]['hashes'][-1]
    items=[]
    row={'offOn':analyze_pair(*paths[:2]),'sha256':shot['hashes'],'draw':shot['special']['drawStats']}
    if base:
        shutil.copyfile(base,out/(key+'-r9.png'))
        row['independent']=analyze_pair(base,paths[1]);row['baselineOff']=analyze_pair(base,paths[0]);row['baselineSha256']=digest(base)
        items.append(('R9 independent / on',base))
    items.extend([('R10 same frame / off',paths[0]),('R10 same frame / on',paths[1])])
    sheet(key,items)
    if key in ('shop-b','laundry-d'):
        boxes=({'vending-faces':[28,384,555,620],'vending-bases':[22,620,560,824],'edge-slit':[290,660,350,762],
                'platform-cut':[555,635,715,715],'door-landing':[555,603,1235,775],'front-pavement':[550,785,1350,890]}
               if key=='shop-b' else {'stairs':[125,649,805,900],'lower-steps':[150,708,780,900],'next-to-stairs':[811,675,1090,763]})
        row['regions']={}
        for label,box in boxes.items():
            row['regions'][label]={'offOn':analyze_pair(*paths[:2],box),'independent':analyze_pair(base,paths[1],box)}
            crops=[Image.open(p).convert('RGB').crop(box) for _,p in items]
            width,height=crops[0].size
            montage=Image.new('RGB',(width*3,height+24),'white')
            pen=ImageDraw.Draw(montage)
            for i,((title,_),crop) in enumerate(zip(items,crops)):
                montage.paste(crop,(i*width,24));pen.text((i*width+4,5),title,fill='black')
            montage.save(out/(key+'-'+label+'.png'))
    rows[key]=row
(out/'measurements.json').write_text(json.dumps(rows,indent=2)+'\n',encoding='utf8')
