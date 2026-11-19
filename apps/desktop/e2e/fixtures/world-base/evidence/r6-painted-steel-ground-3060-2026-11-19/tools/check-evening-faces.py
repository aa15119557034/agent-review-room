import gzip, hashlib, json, subprocess, sys
from pathlib import Path
from PIL import Image
import numpy as np
root,fixture=map(Path,sys.argv[1:3])
def read(f):return json.loads(f.read_text(encoding='utf8'))
ref=read(root/'sources.json')['base']
prefix='apps/desktop/e2e/fixtures/world-base/evidence/plaza-final-ground-3060-2026-11-19/reflections/evening'
served={}
for arm in ('before','after'):
    served[arm]={r['path']:r['sha256'] for r in read(root/('photos-'+arm)/'report.json')['transportAudit']['served'] if r['status']==200 and r['finished'] and r['sha256']==r['wireSHA256']}
results={}
for face in ('px','nx','py','ny','pz','nz'):
    src=fixture/'src/street-env-evening'/(face+'.png')
    raw=Path(src).read_bytes()
    digest=hashlib.sha256(raw).hexdigest()
    url='/src/street-env-evening/'+face+'.png'
    assert all(served[arm][url]==digest for arm in served)
    encoded=np.array(Image.open(src).convert('RGBA'))
    assert encoded.shape==(256,256,4) and np.all(encoded[:,:,3]==255)
    hdr=gzip.decompress(subprocess.check_output(['git','cat-file','blob',f'{ref}:{prefix}/{face}.rgba16f.gz'],cwd=fixture))
    linear=np.frombuffer(hdr,'<f2').reshape((256,256,4))[:,:,:3].astype('float64')
    assert np.isfinite(linear).all() and linear.min()>=0
    peak=linear.max(axis=-1);limited=linear/np.maximum(1,peak[:,:,None]/2);normalized=limited/2
    expected=np.floor(255*np.where(normalized<=.0031308,12.92*normalized,1.055*normalized**(1/2.4)-.055)+.5).astype('uint8')
    enc=encoded[:,:,:3]/255;decoded=2*np.where(enc<=.04045,enc/12.92,((enc+.055)/1.055)**2.4)
    results[face]={'sha256':digest,'texels':int(peak.size),'aboveOriginalLimit':int((peak>2).sum()),'originalMax':float(peak.max()),'decodedMax':float(decoded.max()),'mismatchedAgainstPinnedBake':int(np.any(expected!=encoded[:,:,:3],axis=-1).sum())}
assert max(r['decodedMax'] for r in results.values())<=2
assert sum(r['mismatchedAgainstPinnedBake'] for r in results.values())==0
(root/'evening-reflections.json').write_text(json.dumps({'retainedOriginal':ref,'faces':results},indent=2)+'\n',encoding='utf8')
print('source texels',sum(r['texels'] for r in results.values()),'over2',sum(r['aboveOriginalLimit'] for r in results.values()),'current max',max(r['decodedMax'] for r in results.values()),'mismatch',sum(r['mismatchedAgainstPinnedBake'] for r in results.values()))
