"""Verify and package two photo runs, four timing runs and two legacy runs."""
import gzip
import hashlib
import json
import math
import shutil
import sys
from pathlib import Path

archive = Path(__file__).resolve().parents[1]
root = Path(sys.argv[1]) if len(sys.argv)>1 else archive.parent
sha = {'before':'9b0dadbd7fd3c117835465fe6ea8dd80c4215970','after':'eb000ad5f3bd976cfbb485fe3606442c82309ab5'}

def read(f): return json.loads(f.read_text(encoding='utf-8-sig'))
def digest(f): return hashlib.sha256(f.read_bytes()).hexdigest()
def copy(f,path,expected=None):
    if expected: assert digest(f)==expected,(f,expected)
    dest=archive/path
    dest.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(f,dest)
def write(f,obj): (archive/f).write_text(json.dumps(obj,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
cameras=read(root/'cameras.json')
keys=[v['name'] for v in cameras]
summary={'sources':sha,'cameras':cameras,'photos':{},'timing':[],'legacy':{}}
copy(root/'cameras.json','tools/cameras.json')
capture_tools=['ground-photos.cjs','timing-eight.cjs','legacy-sixth.cjs','measure-ground.cjs','plaza-capture.cjs','plaza-timing.cjs']
for name in capture_tools:
    if (root/name).exists(): copy(root/name,'tools/'+name)
if (root/'sources.json').exists(): copy(root/'sources.json','tools/sources.json')
if (root/'baseline-recapture.json').exists(): copy(root/'baseline-recapture.json','baseline-recapture.json')
photo_ref={}
summary['assets']={}
for arm,commit in sha.items():
    folder=root/('photos-'+arm)
    r=read(folder/'report.json')
    assert r['source']==commit and r['complete'] and not r['exceptions'] and r['transportAudit']['payloadIntegrityClean']
    special=r['photos'][keys[0]]['special']
    textures=[i for i in r['transportAudit']['served'] if i['path'].startswith('/apartment-assets/')]
    assert len(textures)==9 and all(i['status']==200 and i['finished'] and i['sha256']==i['wireSHA256'] for i in textures)
    assert len(r['packageHttp'])==4 and all(i['status']==200 and i['bytes']>0 for i in r['packageHttp'])
    summary['assets'][arm]=dict(textures={i['path']:i['sha256'] for i in textures},packages={i['pathname']:i['sha256'] for i in r['packageHttp']},decals={k:special['plan'][k] for k in ['posters','stickers','doodles']},fingerprint=special['fingerprint'],materials=r['facadeMaterials'])
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
assert summary['assets']['before']==summary['assets']['after']
failed_folder=Path(sessions[0]['fixture'])/'artifacts'/'r7-native-1119-5-before'
if (failed_folder/'render-report.json').exists() and not read(failed_folder/'render-report.json')['renderOk']:
    dest=archive/'excluded/r7-native-1119-5-before'
    dest.mkdir(parents=True,exist_ok=True)
    for file in sorted(failed_folder.glob('frame-samples-*.json'))+[failed_folder/'render-report.json']:
        (dest/(file.name+'.gz')).write_bytes(gzip.compress(file.read_bytes(),mtime=0))
    for file in ['source-manifest.json','native.log']: copy(failed_folder/file,'excluded/r7-native-1119-5-before/'+file)
    for name in ['r7-retry-1119a-prior-state.json','r7-native-1119-5-before.log']:
        if (root/name).exists(): copy(root/name,'excluded/r7-native-1119-5-before/'+name)
assert [(s['test'],s['arm'],s['status']) for s in sessions]==[('photos','before',0),('photos','after',0),('timing','before',0),('timing','after',0),('timing','after',0),('timing','before',0),('legacy','before',0),('legacy','after',0)]
copy(root/'running-state.json','receipts/running-state.json')
runs=[s for s in sessions if s['test']=='timing']
assert [s['arm'] for s in runs]==['before','after','after','before']
for idx,s in enumerate(runs,1):
    arm=s['arm']; folder=Path(s['fixture'])/'artifacts'/s['id']
    r=read(folder/'frame-times.json'); detail=read(folder/'render-report.json')
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
for arm in sha:
    folder=root/('legacy-'+arm); r=read(folder/'legacy.json')
    assert r['source']==sha[arm] and r['ok'] and not r['exceptions']
    assert len(r['views'])==5
    if arm=='before': reference=r
    else: assert r['cameraSourceSha256']==reference['cameraSourceSha256']
    for k,v in r['views'].items():
        assert v['camera']==reference['views'][k]['camera'] and 'RTX 3060 Laptop' in v['gpu'] and v['durationMs']>=6500
        copy(folder/(k+'.png'),f'legacy/{arm}/{k}.png',v['pngSHA256'])
    for name in ['legacy.json','legacy-frames.json.gz','legacy-network.json.gz']: copy(folder/name,f'legacy/{arm}/{name}')
    summary['legacy'][arm]=r['views']
write('summary.json',summary)
