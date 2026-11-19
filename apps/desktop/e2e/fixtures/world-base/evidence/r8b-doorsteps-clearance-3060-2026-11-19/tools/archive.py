"""Verify and package two matched photo sets and one timing run per revision."""
import gzip
import hashlib
import json
import math
import shutil
import sys
from pathlib import Path

archive = Path(__file__).resolve().parents[1]
root = Path(sys.argv[1]) if len(sys.argv)>1 else archive.parent
sha = {'before':'be8879045b4908695fa62342afc1a0b9ec05bb96','after':'6ef4686b630dd14f36945fdcf650bde7e582afd7'}

def read(f): return json.loads(f.read_text(encoding='utf-8-sig'))
def digest(f): return hashlib.sha256(f.read_bytes()).hexdigest()
def copy(f,path,expected=None):
    if expected: assert digest(f)==expected,(f,expected)
    dest=archive/path
    dest.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(f,dest)
def write(f,obj): (archive/f).write_text(json.dumps(obj,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
setup=read(root/'sources.json')
assert setup['sources']==sha
previous=Path(setup['baselinePhotoDirectory']).parent
assert digest(previous/'photos-after/report.json')==setup['baselineReportSha256']
cameras=read(previous/'cameras.json')
keys=[v['name'] for v in cameras]
summary={'sources':sha,'cameras':cameras,'photos':{},'timing':[]}
copy(previous/'cameras.json','tools/cameras.json')
for name in ['ground-photos.cjs','timing-eight.cjs','plaza-capture.cjs','plaza-timing.cjs']:
    copy(previous/name,'tools/'+name)
copy(root.parent/'x51-next-measure.cjs','tools/x51-next-measure.cjs')
copy(root.parent/'rear-r8b.cjs','tools/rear-r8b.cjs')
copy(root/'sources.json','tools/sources.json')
photo_ref={}
summary['assets']={}
for arm,commit in sha.items():
    folder=(previous if arm=='before' else root)/'photos-after'
    r=read(folder/'report.json')
    assert r['source']==commit and r['complete'] and not r['exceptions'] and r['transportAudit']['payloadIntegrityClean']
    special=r['photos'][keys[0]]['special']
    textures=[i for i in r['transportAudit']['served'] if i['path'].startswith('/apartment-assets/')]
    assert len(textures)==9 and all(i['status']==200 and i['finished'] and i['sha256']==i['wireSHA256'] for i in textures)
    assert len(r['packageHttp'])==4 and all(i['status']==200 and i['bytes']>0 for i in r['packageHttp'])
    summary['assets'][arm]=dict(textures={i['path']:i['sha256'] for i in textures},packages={i['pathname']:i['sha256'] for i in r['packageHttp']},decals={k:special['plan'][k] for k in ['posters','stickers','doodles']},fingerprint=special['fingerprint'],materials=r['facadeMaterials'])
    summary['assets'][arm]['bakedItems']=special['bakedItems']
    summary['photos'][arm]={}
    for c in cameras:
        k=c['name']; shot=r['photos'][k]
        assert shot['eye']==c['eye'] and shot['view']['target']==c['target'] and shot['fov']==c['fov']
        assert shot['canvas']==[1440,900] and shot['time']==shot['islandTime']==14 and shot['timeOfDay']=='evening' and shot['hidden']
        assert 'RTX 3060 Laptop' in shot['gpu']
        if arm=='before': photo_ref[k]=shot['quaternion']
        else: assert shot['quaternion']==photo_ref[k]
        filehash=shot['hashes'][-1]
        copy(folder/(k+'.png'),f'photos/{arm}/{k}.png',filehash)
        summary['photos'][arm][k]=filehash
    copy(folder/'return-a.png',f'photos/{arm}/return-a.png',r['photos']['return-a']['hashes'][-1])
    dest=archive/'receipts'/('photos-'+arm+'.json.gz')
    dest.parent.mkdir(exist_ok=True)
    dest.write_bytes(gzip.compress((folder/'report.json').read_bytes(),mtime=0))
sessions=read(root/'running-state.json')
assert all(summary['assets']['before'][k]==summary['assets']['after'][k] for k in ['textures','packages','decals','materials'])
assert summary['assets']['before']['bakedItems']==summary['assets']['after']['bakedItems'] and len(summary['assets']['after']['bakedItems'])==26
assert all(s['status']==0 for s in sessions)
copy(root/'running-state.json','receipts/running-state.json')
runs=[s for s in sessions if s['test']=='timing']
assert [s['arm'] for s in runs]==['before','after']
for idx,s in enumerate(runs,1):
    arm=s['arm']; folder=Path(s['output'])
    r=read(folder/'frame-times.json'); detail=read(folder/'render-report.json')
    scene=detail['scene']['city']
    fields=['geometries','materials','modelPrimitives','totalTriangles','modelTriangles','ownedTextures','uniqueTextures','borrowedTextures','newTexturePixels','textureCacheEntriesAdded']
    counts={k:scene[k] for k in fields}
    counts['artDoorsteps']=scene.get('artDoorsteps')
    counts['apartmentTriangles']={b['name']:b['staticTriangles'] for b in scene['placements'] if b['type']=='apartment'}
    if arm in summary.setdefault('city',{}): assert summary['city'][arm]==counts
    summary['city'][arm]=counts
    assert r['source']==sha[arm] and r['renderOk'] and r['nativeExit']==0 and 'RTX 3060 Laptop' in r['gpu']
    assert all(i['trusted'] for i in r['walkingInputs']) and detail['transportAudit']['payloadIntegrityClean']
    assert all(w['start']['page']['visibility']==w['end']['page']['visibility']=='visible' for w in detail['quietWindows'])
    tag=f'timing/{idx}-{arm}'; frames=folder/'frames.json.gz'
    copy(frames,tag+'/frames.json.gz',r['samples']['sha256'])
    raw=json.loads(gzip.decompress(frames.read_bytes()))
    assert list(raw)==keys+['walk-third','walk-first']
    compact={}
    for k,rows in raw.items():
        m=r['segments'][k]; interval=sorted(v['ms'] for v in rows); n=len(interval)
        elapsed=sum(interval)
        fps=1000*n/elapsed
        p95=interval[math.ceil(n*.95)-1]
        assert n==m['frames'] and math.isclose(elapsed,m['durationMs'],abs_tol=1e-6)
        assert math.isclose(fps,m['fps']) and math.isclose(p95,m['p95Ms'])
        assert m['pass']==(fps>=60 and p95<=16.7)
        if k in keys: assert elapsed>=10000 and m['camera']['quaternion']==photo_ref[k]
        else: assert elapsed>=3000 and m['walk']['distanceXZ']>1
        compact[k]={**{x:m[x] for x in ['frames','fps','p95Ms','p99Ms','maxMs','pass','durationMs']},
                    'calls':[min(v['calls'] for v in rows),max(v['calls'] for v in rows)],
                    'triangles':[min(v['triangles'] for v in rows),max(v['triangles'] for v in rows)]}
    for f in ['frame-times.json','source-manifest.json']: copy(folder/f,tag+'/'+f)
    (archive/tag/'render-report.json.gz').write_bytes(gzip.compress((folder/'render-report.json').read_bytes(),mtime=0))
    summary['timing'].append({'tag':tag,'source':r['source'],'segments':compact})
rear={}
for arm,commit in sha.items():
    folder=(previous if arm=='before' else root)/'rear-after'
    r=read(folder/'report.json')
    assert r['source']==commit and r['complete'] and not r['exceptions'] and r['transportAudit']['payloadIntegrityClean']
    assert list(r['photos'])==['rear-3f','rear-5f','rear-4f-parcels']
    rear[arm]={}
    for k,m in r['photos'].items():
        assert 'RTX 3060 Laptop' in m['gpu'] and m['canvas']==[1440,900] and m['glError']==0 and m['hidden']
        if arm=='after':
            assert all(m[x]==rear['before'][k][x] for x in ['eye','quaternion','view','fov','time','location'])
        copy(folder/(k+'.png'),f'rear/{arm}/{k}.png',m['hashes'][-1])
        rear[arm][k]=m
    (archive/'receipts'/('rear-'+arm+'.json.gz')).write_bytes(gzip.compress((folder/'report.json').read_bytes(),mtime=0))
summary['rear']=rear
write('summary.json',summary)
