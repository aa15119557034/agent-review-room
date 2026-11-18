"""Compare the supplied V2 and final 1440x900 native captures without image registration."""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import numpy as np


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def pixels(a,b):
    delta=np.abs(a.astype(np.int16)-b.astype(np.int16))
    largest=delta.max(axis=-1)
    return {"pixels":int(largest.size),"changed":int((largest>0).sum()),"over8":int((largest>8).sum()),"maxRGB":delta.max(axis=(0,1)).tolist(),"meanAbsoluteRGB":np.round(delta.mean(axis=(0,1)),5).tolist()}


def read_image(file):
    with Image.open(file) as im:
        assert im.size==(1440,900)
        return im.convert('RGB')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('previous',type=Path)
    parser.add_argument('final',type=Path)
    parser.add_argument('output',type=Path)
    args=parser.parse_args()
    out=args.output; out.mkdir(parents=True,exist_ok=True)
    old=json.loads((args.previous/'report.json').read_text(encoding='utf-8'))
    new=json.loads((args.final/'report.json').read_text(encoding='utf-8'))
    assert old['source'].startswith('eed4fb46') and new['source'].startswith('1ea97233') and old['complete'] and new['complete']
    rows={}
    names=[n for n in new['photos'] if n!='return-a']
    boards=[Image.new('RGB',(1004,4*316+32),'#171b20') for _ in range(2)]
    for board in boards:
        draw=ImageDraw.Draw(board)
        draw.text((12,9),'V2   eed4fb46',fill='white')
        draw.text((514,9),'Final   1ea97233',fill='white')
    for i,n in enumerate(names):
        a,b=old['photos'][n],new['photos'][n]
        for key in ('eye','quaternion','fov','view','time','islandTime','timeOfDay','canvas','hidden'):
            assert a[key]==b[key],(n,key)
        oldFile=args.previous/a['file']; newFile=args.final/b['file']
        assert digest(oldFile)==a['hashes'][-1] and digest(newFile)==b['hashes'][-1]
        left,right=read_image(oldFile),read_image(newFile)
        la,ra=np.asarray(left),np.asarray(right)
        rows[n]={"eye":b['eye'],"quaternion":b['quaternion'],"target":b['view']['target'],"fov":b['fov'],"clock":b['time'],"canvas":b['canvas'],"ground":b['ground'],"eyeHeight":b['eyeHeight'],"beforeSha256":a['hashes'][-1],"afterHashes":b['hashes'],"glError":b['glError'],**pixels(la,ra)}
        (out/b['file']).write_bytes(newFile.read_bytes())
        board=boards[i//4]; y=32+(i%4)*316
        for x,im in ((0,left),(504,right)):
            board.paste(im.resize((500,312),Image.Resampling.LANCZOS),(x,y))
        if i==0:
            crop=(397,159,915,420); sign=(618,294,872,320)
            detail=Image.new('RGB',(1036,261))
            detail.paste(left.crop(crop),(0,0)); detail.paste(right.crop(crop),(518,0))
            detail.save(out/'plaza-crown-and-gate-1to1.png')
            for tag,(x0,y0,x1,y1) in [('crownAndGate',crop),('gateText',sign)]:
                rows[n][tag]={'xyxy':[x0,y0,x1,y1],**pixels(la[y0:y1,x0:x1],ra[y0:y1,x0:x1])}
    for board,name in zip(boards,['station-ground','island-ground']):
        board.save(out/(name+'.jpg'),quality=92,subsampling=0)
    st=new['photos']['art-a-street']; end=new['photos']['return-a']
    for k in ('eye','quaternion','fov','view','time'):assert st[k]==end[k]
    result={'previous':old['source'],'final':new['source'],'startedAt':new['startedAt'],'finishedAt':new['finishedAt'],'renderer':st['gpu'],'exceptions':new['exceptions'],'http':new['packageHttp'],'networkFailures':[{"path":r['url'].split('/',3)[-1],"error":r.get('error',r.get('errorText')),"canceled":r.get("canceled")} for r in new['networkFailures']],'returnA':{'hashes':end['hashes'],**pixels(np.asarray(read_image(args.final/st['file'])),np.asarray(read_image(args.final/end['file'])))},'photos':rows}
    (out/'photos.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print([(name, row['changed']) for name,row in rows.items()])
    print('gate text',rows[names[0]]['gateText'])

if __name__=='__main__':
    main()
