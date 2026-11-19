import json,sys
sys.dont_write_bytecode=True
from pathlib import Path
from PIL import Image, ImageDraw
from clipping import analyze_pair
root=Path(__file__).resolve().parents[1]
sources=json.loads((root/'tools/sources.json').read_bytes())['sources']
stats={}
for half in range(2):
    sheet=Image.new('RGB',(960,4*324),'white')
    pen=ImageDraw.Draw(sheet)
    for i,c in enumerate(json.loads((root/'tools/cameras.json').read_bytes())[half*4:half*4+4]):
        k=c['name']; paths=[root/'photos'/arm/(k+'.png') for arm in ('before','after')]
        stats[k]=analyze_pair(*paths)
        for j,p in enumerate(paths):
            with Image.open(p) as im:sheet.paste(im.convert('RGB').resize((480,300),Image.Resampling.LANCZOS),(480*j,324*i+23))
            pen.text((480*j+5,324*i+5),k+' / '+list(sources.values())[j][:8],fill='black')
    sheet.save(root/('ground-'+['a-d','e-h'][half]+'.jpg'),quality=89)
(root/'ground-deltas.json').write_text(json.dumps(stats,indent=2)+'\n',encoding='utf8')
