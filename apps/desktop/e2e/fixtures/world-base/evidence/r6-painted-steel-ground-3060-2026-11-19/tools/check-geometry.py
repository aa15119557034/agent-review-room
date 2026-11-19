import json, sys
from pathlib import Path
import numpy as np
from PIL import Image
root=Path(sys.argv[1])
def img(p): return np.array(Image.open(p).convert('RGB'))
def diff(a,b):
    d=np.abs(a.astype('int16')-b.astype('int16')).max(axis=-1)
    return {'changed':int((d>0).sum()),'over2':int((d>2).sum()),'max':int(d.max())}
def qpixels(a,points):
    return np.stack([a[pt['y'],pt['x']] for pt in points])
def signal(a):
    return {'rgbMedian':np.median(a,axis=0).tolist(),'lumaMedian':round(float(np.median(a@np.array([.2126,.7152,.0722]))),3)}
result={}
for arm in ['before','after']:
    d=root/('diagnosis-'+arm)
    data=json.loads((d/'data.json').read_text(encoding='utf8'))
    assert data['ok'] and not data['exceptions']
    reports={}
    for name, row in data['views'].items():
        frames={k:img(d/x['file']) for k,x in row['shots'].items()}
        src=frames['authored']
        v={'restore':diff(src,frames['restored'])};reports[name]=v
        if name=='sample-e-harbour':
            v['cityHidden']=diff(src,frames['cityHidden'])
            continue
        v['materialEvidence']=row['materialEvidence']
        if name=='art-d-laundry':
            top=[r for r in row['rays'] if r['y'] in [130,150]]
            v['guardrailSamples']=len(top)
            v['guardrailMaterials']={}
            for pt in top:
                hit=pt['hits'][0]
                label=hit['material']+'  '+hit['object']
                v['guardrailMaterials'][label]=v['guardrailMaterials'].get(label,0)+1
            v['portalFirstHits']=sum(pt['hits'][0]['portal'] for pt in top)
            v['sampleSignal']=signal(qpixels(src,top))
            v['samplesHidingPortal']=diff(qpixels(src,top),qpixels(frames['portalHidden'],top))
            v['samplesHidingApartmentMetal']=diff(qpixels(src,top),qpixels(frames['apartmentMetalHidden'],top))
            upper=(slice(44,194),slice(395,1390));front=(slice(355,653),slice(131,1394))
            v['upperHidingPortal']=diff(src[upper],frames['portalHidden'][upper])
            v['shopHidingPortal']=diff(src[front],frames['portalHidden'][front])
        else:
            for kind,points in [('treads',[r for r in row['rays'] if r['x']==990]),('fencePosts',[r for r in row['rays'] if r['x']==1234])]:
                v[kind]={'count':len(points),'firstHitMaterials':sorted(set(p['hits'][0]['material'] for p in points)),
                    'pixelSignal':signal(qpixels(src,points)),'hideMetal':diff(qpixels(src,points),qpixels(frames['apartmentMetalHidden'],points))}
        m=row['materialEvidence']['apartment-pbr-metal'];r=row['materialEvidence']['apartment-pbr-roof']
        assert m['hasDiffuse']==(arm=='before') and bool(m['metalnessMap'])==(arm=='before')
        assert m['normal'] and m['rough'] and m['aoMap'] and m['metalness']==(1 if arm=='before' else .15)
        assert r['hasDiffuse'] and r['metalnessMap'] and abs(r['metalness']-.25)<1e-6
    result[arm]=reports
(root/'geometry-summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
for arm,t in result.items():
    print(arm,{k:{a:b for a,b in v.items() if a!='materialEvidence'} for k,v in t.items()})
