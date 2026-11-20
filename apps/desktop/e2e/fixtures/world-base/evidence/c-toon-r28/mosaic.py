import sys
from PIL import Image, ImageDraw
# mosaic.py out.jpg left.png right.png [labelL labelR]
out,l,r=sys.argv[1:4]; ll=sys.argv[4] if len(sys.argv)>4 else 'toon off'; lr=sys.argv[5] if len(sys.argv)>5 else 'toon on'
a=Image.open(l).convert('RGB'); b=Image.open(r).convert('RGB')
w,h=a.size; m=Image.new('RGB',(w*2+6,h),(255,255,255)); m.paste(a,(0,0)); m.paste(b,(w+6,0))
d=ImageDraw.Draw(m)
for x,t in ((8,ll),(w+14,lr)):
    d.rectangle((x-4,6,x+len(t)*9+8,28),fill=(0,0,0)); d.text((x,10),t,fill=(255,255,255))
m.save(out,quality=88)
