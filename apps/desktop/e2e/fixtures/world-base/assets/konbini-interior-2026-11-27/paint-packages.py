"""Original shelf packaging, signs and POS displays for the W1 fixture."""
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).parent
GRID, TILE = 8, 128
ATLAS = Image.new('RGB', (GRID*TILE, GRID*TILE), '#f0e8d5')
DRAW = ImageDraw.Draw(ATLAS)
FONT = next(p for p in (
    Path('C:/Windows/Fonts/msgothic.ttc'), Path('C:/Windows/Fonts/msyh.ttc'),
    Path('C:/Windows/Fonts/segoeui.ttf')) if p.exists())
FONT_BOLD = next((p for p in (Path('C:/Windows/Fonts/msyhbd.ttc'), Path('C:/Windows/Fonts/segoeuib.ttf')) if p.exists()), FONT)

PRODUCTS = [
    ('pear','洋なし','PEAR','639f68','e8d484','fruit'),
    ('lime','ライム','LIME','338d7c','e5e481','fruit'),
    ('momo','もも','MOMO','d9768b','fce3cf','fruit'),
    ('cola','星コーラ','HOSHI','b65a54','f8d285','star'),
    ('water','天然水','AOMI','568fb5','c6e7ee','wave'),
    ('barley','麦茶','MUGI','b88b40','f8e2a3','leaf'),
    ('sencha','せん茶','SENCHA','4b8065','d8e198','leaf'),
    ('coffee','黒珈琲','KŌHI','514d4c','e4ba7c','bean'),
    ('milk','牛乳','MILK','f5f0db','629bb9','wave'),
    ('cocoa','ココア','COCOA','90614d','efd5a2','bean'),
    ('orange','みかん','MIKAN','df8859','ffe072','fruit'),
    ('grape','ぶどう','BUDŌ','856e9a','efc5e5','fruit'),
    ('soup','朝スープ','SOUP','d29761','f8edc7','bowl'),
    ('shio','塩ラーメン','SHIO','dba769','fff1c1','bowl'),
    ('miso','みそ麺','MISO','ad6d59','f6cc93','bowl'),
    ('soba','とうふそば','SOBA','615f81','e2ceb8','bowl'),
    ('sea','のりせん','NORI','4d7c70','d5dc9d','leaf'),
    ('crisp','ポテト','CRISP','c67150','f8dc96','chip'),
    ('rice','米ぽん','KOME','dcb667','fff0c9','chip'),
    ('castella','カステラ','KASU','dc985c','fff3b1','chip'),
    ('mint','はっか','HAKKA','599997','d1ead4','star'),
    ('umi','うみノート','UMI','3b7385','f5d083','wave'),
    ('sakura','さくら飴','SAKURA','cf7583','fbd3c5','flower'),
    ('choco','チョコ','CHOCO','76515e','f8d99c','bean'),
    ('paper','白い紙箱','MORI','e5cfb1','868e70','leaf'),
    ('towel','手ぬぐい','TENUGUI','9bafad','f9e9ca','wave'),
    ('powder','おそうじ','KIREI','5c8f9f','d5e7d8','star'),
    ('bento','日替弁当','BENTO','313c43','edd084','tray'),
    ('lunch','お昼ごはん','LUNCH','674b4b','ffdfb6','tray'),
    ('sando','たまご','SANDO','edc678','faf0cd','fruit'),
    ('salmon','さけ','SAKE','988b61','f9bf95','rice'),
    ('ume','うめ','UME','668775','eac0c0','rice'),
    ('seaweed','こんぶ','KONBU','426d69','cdd4b3','rice'),
    ('pudding','ぷりん','PUDIN','d4a35b','f4e0a4','chip'),
    ('yogurt','ヨーグルト','YOGURT','8899a7','f2e9d3','bowl'),
]
MAGAZINES = [
    ('coast','海のあと','COAST','426b89','e4cd9e'),
    ('city','まちの窓','CITY','c16c65','f5d1a6'),
    ('trail','坂のみち','WALK','6c8e75','efe3ad'),
    ('craft','手でつくる','CRAFT','806e9b','e2c99e'),
    ('night','夕暮れ','DUSK','3a505e','eda891'),
    ('home','今日の台所','LIVING','ac8059','f8e7bc'),
    ('garden','庭あそび','GARDEN','42796b','dcdc9f'),
    ('read','よむ休日','SUNDAY','a16a75','eed3c6'),
]
SIGNS = [
    ('tag_snacks','お菓子','SNACKS','396e68','ecce87'),
    ('tag_meals','麺・ごはん','PANTRY','895b52','f1cd91'),
    ('tag_daily','日用品','DAILY GOODS','4f6b82','d4dfdd'),
    ('tag_drinks','冷たい飲み物','CHILLED DRINKS','3b6f81','d6ece9'),
    ('tag_bento','お弁当','READY MEALS','847050','fae4b7'),
    ('tag_read','雑誌・本','MAGAZINES','655984','ead2ab'),
    ('tag_register','ひだまりマート','HIDAMARI MART','33776d','f4daa0'),
    ('offer','季節のおやつ','SEASONAL PICKS','b76560','f6d3a0'),
    ('warm','あたたかい','WARM SNACKS','9b6654','f0be83'),
    ('cold','冷蔵','KEEP COLD','538c97','e0ede3'),
    ('coffee_menu','淹れたて','FRESH COFFEE','71504a','f2d7a5'),
]
PRICES = ('128','158','198','248','398','468')
SCREENS = ('pos','terminal','customer')
records = {}


def begin(key, bg):
    index = len(records)
    if index >= GRID*GRID:
        raise ValueError('Packaging atlas is full')
    x, y = (index % GRID)*TILE, (index // GRID)*TILE
    DRAW.rectangle((x,y,x+TILE-1,y+TILE-1), fill='#'+bg)
    records[key] = {'cell': [index % GRID,index // GRID], 'color': bg}
    return x,y


def title(x, y, text, color, maximum, size=24, font=FONT_BOLD):
    while size > 8:
        face = ImageFont.truetype(str(font), size)
        if DRAW.textlength(text,font=face) <= maximum:
            break
        size -= 1
    DRAW.text((x,y),text, fill=color, font=face, anchor='lt')


def product(item):
    key, jp, brand, bg, accent, motif = item
    x,y=begin(key,bg)
    hi='#'+accent
    dark='#293d3e'
    DRAW.polygon(((x+8,y+96),(x+120,y+65),(x+120,y+108),(x+8,y+108)),fill=hi)
    DRAW.ellipse((x+32,y+28,x+96,y+90),fill=hi,outline='#fbefcd',width=2)
    if motif=='fruit':
        DRAW.ellipse((x+43,y+42,x+85,y+78),fill='#'+bg,outline=dark,width=2)
        DRAW.polygon(((x+63,y+46),(x+72,y+33),(x+83,y+37),(x+75,y+47)),fill=dark)
        DRAW.arc((x+52,y+50,x+77,y+70),186,290,fill=hi,width=2)
    elif motif in ('leaf','bean'):
        DRAW.polygon(((x+41,y+73),(x+58,y+42),(x+88,y+37),(x+85,y+62),(x+73,y+75)),fill='#'+bg)
        DRAW.line(((x+41,y+75),(x+84,y+43)), fill=dark,width=2)
        DRAW.line(((x+62,y+57),(x+57,y+49)), fill=dark,width=2)
    elif motif=='wave':
        for n in range(3):
            a=y+42+n*11
            DRAW.arc((x+42,a,x+85,a+15),8,183,fill='#'+bg,width=5)
    elif motif in ('rice','tray'):
        DRAW.rounded_rectangle((x+41,y+41,x+87,y+77),5,fill=dark)
        DRAW.ellipse((x+47,y+46,x+83,y+74),fill='#fcf0d3')
        DRAW.rectangle((x+55,y+55,x+73,y+69),fill='#'+bg)
    elif motif=='bowl':
        DRAW.pieslice((x+43,y+45,x+84,y+76),0,180,fill=dark)
        for n in range(3):
            DRAW.arc((x+46+n*9,y+35,x+55+n*9,y+58),190,360,fill='#'+bg,width=2)
    elif motif in ('star','flower'):
        DRAW.polygon(((x+63,y+37),(x+70,y+53),(x+86,y+52),(x+74,y+65),(x+79,y+80),
                      (x+62,y+72),(x+48,y+79),(x+51,y+65),(x+41,y+53),(x+57,y+53)),fill='#'+bg)
    else:
        for dx,dy in ((0,6),(16,0),(24,17)):
            DRAW.rounded_rectangle((x+41+dx,y+42+dy,x+60+dx,y+59+dy),6,fill='#'+bg)
    title(x+15,y+10,brand,'#fff6de',98,19)
    title(x+13,y+91,jp,dark,100,17)
    DRAW.line((x+16,y+114,x+92,y+114),fill=hi,width=2)


def magazine(item):
    key,jp,brand,bg,accent=item
    x,y=begin(key,bg)
    hi='#'+accent
    DRAW.rectangle((x+10,y+11,x+118,y+117),outline=hi,width=2)
    DRAW.ellipse((x+65,y+34,x+104,y+72),fill=hi)
    DRAW.polygon(((x+12,y+110),(x+12,y+88),(x+45,y+62),(x+74,y+89),
                  (x+96,y+73),(x+116,y+87),(x+116,y+110)),fill='#304655')
    DRAW.line((x+18,y+102,x+92,y+74),fill=hi,width=3)
    title(x+16,y+17,brand,hi,91,24)
    title(x+16,y+93,jp,hi,95,16)


def sign(item):
    key,jp,brand,bg,accent=item
    x,y=begin(key,bg)
    hi='#'+accent
    DRAW.rounded_rectangle((x+8,y+12,x+119,y+115),8,fill=hi)
    DRAW.rectangle((x+8,y+18,x+119,y+28),fill='#'+bg)
    title(x+13,y+37,jp,'#28373b',101,26)
    title(x+13,y+79,brand,'#'+bg,103,17)


for source in PRODUCTS:
    product(source)
for source in MAGAZINES:
    magazine(source)
for source in SIGNS:
    sign(source)
for value in PRICES:
    x,y=begin('price_'+value,'f5eacb')
    DRAW.rectangle((x+10,y+11,x+116,y+114),outline='#bdd0c2',width=3)
    DRAW.rectangle((x+92,y+16,x+111,y+34),fill='#d18a6d')
    title(x+14,y+36,value,'#23414c',92,63)
    title(x+86,y+87,'円','#23414c',26,17)
for name in SCREENS:
    x,y=begin(name,'1e3742')
    DRAW.rectangle((x+9,y+9,x+118,y+118),fill='#35606a')
    DRAW.rectangle((x+15,y+15,x+111,y+46),fill='#7cc0b4')
    title(x+18,y+19,'¥  528','#1c4449',89,26)
    for n in range(4):
        DRAW.rounded_rectangle((x+19,y+58+n*11,x+47+n*11,y+65+n*11),2,fill='#a7cac1')

ATLAS.save(ROOT/'konbini-packages.png',optimize=True)
(ROOT/'atlas-layout.json').write_text(json.dumps({'grid':GRID,'tile':TILE,'items':records},indent=2)+'\n',encoding='utf-8')
