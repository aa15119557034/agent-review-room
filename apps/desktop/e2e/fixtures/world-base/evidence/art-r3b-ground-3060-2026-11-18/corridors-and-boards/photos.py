from pathlib import Path
import sys,json,hashlib,ast
from PIL import Image, ImageDraw, ImageFilter
import numpy as np
f=Path(sys.argv[1]);current=Path(sys.argv[2]);out=Path(sys.argv[3]) if len(sys.argv)>3 else Path('.')
old=f/'evidence/art-r3-ground-3060-2026-11-18'
def report(p):
    name='photos.json' if (p/'photos.json').exists() else 'report.json'
    return json.loads((p/name).read_text('utf-8'))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
a,b=report(old),report(current)
assert a['source'].startswith('47a5c12') and b['source'].startswith('ffbcfa3')
result={'prior':a['source'],'source':b['source'],'views':{}}
boxes={'art-c-alley':{'near':[331,128,413,181],'middle':[750,329,772,345],'far':[858,381,870,390]},'art-d-laundry':{'fascia':[302,204,1136,341],'side':[1105,336,1255,665]}}
for view,regions in boxes.items():
    m,n=a['photos'][view],b['photos'][view]
    for k in ('eye','quaternion','fov','time','islandTime','canvas'):
        assert m[k]==n[k],(view,k,m[k],n[k])
    assert m['view']['target']==n['view']['target']
    p,q=old/(view+'.png'),current/(view+'.png')
    im1,im2=[np.asarray(Image.open(file).convert('RGB')) for file in (p,q)]
    diff=np.abs(im1.astype(np.int16)-im2)
    def changed(d):return int(np.any(d!=0,axis=-1).sum())
    ys,xs=np.nonzero(np.any(diff!=0,axis=-1))
    bounds=[int(xs.min()),int(ys.min()),int(xs.max()+1),int(ys.max()+1)] if len(xs) else None
    result['views'][view]={'size':[im2.shape[1],im2.shape[0]],'eye':n['eye'],'quaternion':n['quaternion'],'fov':n['fov'],'time':n['time'],'islandTime':n['islandTime'],'sha256':[sha(p),sha(q)],'pixelsChanged':changed(diff),'deltaGt8':int((diff.max(-1)>8).sum()),'changedBounds':bounds,'maxRGB':int(diff.max()),'regions':{key:{'box':v,'changed':changed(diff[v[1]:v[3],v[0]:v[2]])} for key,v in regions.items()}}
    if view=='art-c-alley':
        sampler=old/'corridors-and-boards/photos.py'
        fn=next(node for node in ast.parse(sampler.read_text('utf-8')).body if isinstance(node,ast.FunctionDef) and node.name=='raster')
        names={'np':np,'H':900,'W':1440}
        exec(compile(ast.Module([fn],type_ignores=[]),str(sampler),'exec'),names)
        outlines=json.loads((out/'background-bins.json').read_text('utf-8'))
        x,y,z,w=n['quaternion']
        # Third column of camera rotation. Visible world points lie in front at negative camera Z.
        axis=np.array([2*x*z+2*y*w,2*y*z-2*x*w,1-2*x*x-2*y*y])
        union=np.zeros((900,1440),dtype=bool);projected={}
        change=np.any(diff!=0,axis=-1)
        for k,rec in outlines.items():
            xyz=np.concatenate([np.array(bn['p']).reshape(-1,3) for r in rec for bn in r['bins']])
            depth=-(xyz-n['eye'])@axis
            summary={'depthRangeM':[float(depth.min()),float(depth.max())]}
            if depth.min()>0:
                mask=np.isfinite(names['raster'](rec,n));union|=mask
                yy,xx=np.nonzero(mask)
                summary['projectedBounds']=[int(xx.min()),int(yy.min()),int(xx.max()+1),int(yy.max()+1)]
                summary['overlapChanged']=int(np.sum(mask&change))
            else:
                assert depth.max()<0
                summary['behindCamera']=True
            projected[k]=summary
        for rad in (0,1,2):
            expanded=union if rad==0 else np.asarray(Image.fromarray(union.astype('uint8')*255).filter(ImageFilter.MaxFilter(2*rad+1)))>0
            projected['within%dpx'%rad]=int(np.count_nonzero(change&expanded))
        result['views'][view]['extraCorridorProjection']=projected
        crop=(995,326,1116,426);sw,sh=3*(crop[2]-crop[0]),3*(crop[3]-crop[1])
        plate=Image.new('RGB',(sw*3+16,sh+25),'#21252d');draw=ImageDraw.Draw(plate)
        for i,(label,pixels) in enumerate([('R3',im1),('R3b',im2),('Changed pixels',np.repeat((change*255).astype('uint8')[...,None],3,axis=-1))]):
            draw.text(((sw+8)*i,5),label,fill='white')
            plate.paste(Image.fromarray(pixels).crop(crop).resize((sw,sh),Image.Resampling.NEAREST),((sw+8)*i,25))
        plate.save(out/'C-background-3x.png')
(out/'photos-same-camera.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result))
