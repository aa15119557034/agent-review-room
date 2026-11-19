"""Package or independently verify candidate light-toggle photos, then recompute their paired RGB metrics."""
import gzip,hashlib,json,sys,shutil
from pathlib import Path
sys.dont_write_bytecode=True
from PIL import Image,ImageDraw,ImageFont
from clipping import analyze_pair
archive=Path(__file__).resolve().parents[1]
deep='--deep' in sys.argv
args=[arg for arg in sys.argv[1:] if arg!='--deep']
dest=archive/('door-glow-deep-row' if deep else 'door-glow')
dest.mkdir(exist_ok=True)
if args:
    src=Path(args[0])
    r=json.loads((src/'report.json').read_bytes())
    assert r['complete'] and r['transportAudit']['payloadIntegrityClean'] and not r['exceptions']
    assert r['source']=='4d94a1f41d17f18628e90e2c3f03914e37a3e471'
    (dest/'report.json.gz').write_bytes(gzip.compress((src/'report.json').read_bytes(),mtime=0))
    shutil.copyfile(src/'verification.json',dest/'verification.json')
    for k in r['photos']:
        for suffix in ['off','on','repeat-on']:
            name=f'{k}-{suffix}.png';shutil.copyfile(src/name,dest/name)
else:r=json.loads(gzip.decompress((dest/'report.json.gz').read_bytes()))
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',19)
report={}
for k,v in r['photos'].items():
    paths=[dest/(k+'-'+s+'.png') for s in ['off','on','repeat-on']]
    assert [hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]==v['hashes']
    report[k]={'offOn':analyze_pair(*paths[:2]),'repeat':analyze_pair(*paths[1:]),'draw':v['special']['drawStats'],'lamp':v['special'].get('selectedLamp')}
panels=[('deep-row',['far-west'])] if deep else [('far-doors',['far-west','far-middle','far-east']),('fixed-doors',['corridor-c','street-a','shop-b','rail-g'])]
for name,keys in panels:
    sheet=Image.new('RGB',(1052,35+358*len(keys)),'#171c23');d=ImageDraw.Draw(sheet)
    for col,mode in enumerate(['关闭光斑','开启光斑']):d.text((5+col*532,4),mode,font=font,fill='white')
    for row,k in enumerate(keys):
        for col,suffix in enumerate(['off','on']):
            x,y=col*532,35+row*358
            d.text((x+4,y+1),k,font=font,fill='white')
            with Image.open(dest/(k+'-'+suffix+'.png')) as im:sheet.paste(im.convert('RGB').resize((520,325),Image.Resampling.LANCZOS),(x,y+28))
    sheet.save(archive/(name+'.jpg'),quality=92,subsampling=0)
(archive/('deep-toggle-summary.json' if deep else 'toggle-summary.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print('Verified',len(r['photos'])*3,'toggle PNGs.')
