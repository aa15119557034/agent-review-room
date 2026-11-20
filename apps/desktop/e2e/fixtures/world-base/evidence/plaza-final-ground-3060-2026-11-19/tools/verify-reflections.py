"""Check all 12 native HDR faces, offline PNG bytes and normal-entry GPU readbacks."""
import gzip, hashlib, json, subprocess
from pathlib import Path
from io import BytesIO
import numpy as np
from PIL import Image

root=Path(__file__).resolve().parents[1]
fixture=root.parents[1]
prefix='apps/desktop/e2e/fixtures/world-base/'
summary=json.loads((root/'reflections/comparison.json').read_text('utf8'))
old='7ffb5a118e5e05e8f584955b67813ac383f29c99'
final='1ea97233815bedc700751a04fe69ee7fb28b7a21'
def sha(data): return hashlib.sha256(data).hexdigest()
def arr(b):return np.asarray(Image.open(BytesIO(b)).convert('RGB'))
def from_git(rev,name):return subprocess.check_output(['git','show',rev+':'+prefix+name],cwd=fixture)
def encode(b):
    assert len(b)==256*256*4*2
    rgba=np.frombuffer(b,'<f2').reshape((256,256,4)).astype(np.float64)
    assert np.isfinite(rgba).all()
    rgb=rgba[:,:,:3]; assert rgb.min()>=0
    peak=rgb.max(axis=2); capped=rgb/np.maximum(1,peak[:,:,None]/2)
    assert np.array_equal(rgb[peak<=2],capped[peak<=2]) and capped.max()<=2
    x=capped/2
    quant=np.floor(255*np.where(x<=.0031308,12.92*x,1.055*x**(1/2.4)-.055)+.5).astype('uint8')
    srgb=quant.astype(np.float64)/255
    decoded=2*np.where(srgb<=.04045,srgb/12.92,((srgb+.055)/1.055)**2.4)
    return rgb,quant,int((peak>2).sum()),float(np.max(np.abs(decoded-capped))),float(peak.max())
for profile,folder in [('afternoon','street-env'),('evening','street-env-evening')]:
    directory=root/'reflections'/profile
    receipt=json.loads((directory/'bake.json').read_text('utf8'))
    upload=json.loads((directory/'uploaded.json').read_text('utf8'))
    assert receipt['source']==old and receipt['process']['exit']==0 and receipt['encodingValid'] and receipt['restore']['equal']
    assert upload['source']==final and upload['time']==profile and upload['beforeGL']==upload['afterGL']==0
    assert upload['allGlassShare'] and upload['wetShares'] and upload['runtimeCaptures']==upload['extraWetPasses']==0 and sum(upload['panes'].values())==27
    geo=receipt['preparation'];assert geo['dimensions']==[256,256] and geo['edgesMatch'] and len(geo['edges'])==24
    assert len(geo['rayEquivalence'])==6 and min(d['minDot'] for d in geo['rayEquivalence'])>1-1e-10
    assert np.allclose(geo['origin']['world'],[280,10.264,918])
    for f in upload['faces']:
        name=f['name']; v=summary[profile]['faces'][name]
        row=next(r for r in receipt['faces'] if r['name']==name)
        assert row['glError']==0 and row['time']==14
        raw=gzip.decompress((directory/(name+'.rgba16f.gz')).read_bytes())
        prevFile=directory/('v2-'+name+'.rgba16f.gz')
        before=gzip.decompress(prevFile.read_bytes()) if prevFile.exists() else raw
        assert sha(raw)==row['rawSha256']==v['rawSHA256'] and sha(before)==v['oldRawSHA256']
        source='src/'+folder+'/'+name+'.png'
        oldPNG,newPNG=from_git(old,source),from_git(final,source)
        assert sha(oldPNG)==v['oldPngSHA256'] and sha(newPNG)==v['installedSHA256']
        a,ap,*_=encode(before);b,bp,limited,err,peak=encode(raw)
        assert (limited,peak)==(v['limitPixels'],v['peakBeforeLimit']) and np.isclose(err,v['decodedMaxError'])
        assert np.array_equal(ap,arr(oldPNG)) and np.array_equal(bp,arr(newPNG))
        assert np.any(a!=b,axis=2).sum()==v['linearChangedPixels'] and np.any(ap!=bp,axis=2).sum()==v['encodedChangedPixels']
        if np.array_equal(ap,bp): assert oldPNG==newPNG
        rgba=Image.open(BytesIO(newPNG)).convert('RGBA').tobytes()
        assert sha(rgba)==f['imageRGBA']==f['gpuRGBA'] and f['differentPixels']==f['maxChannelError']==0
        assert len(f['serverRequests'])==1 and f['serverRequests'][0]['http']==200
        # Chromium's resource timing buffer may have dropped an entry. Every face has a server event and the full uploaded RGBA hash.
        assert all(r['http']==200 and r['decoded']==len(newPNG) for r in f['requests'])
print('12 raw RGBA16F faces, decoded/installed PNGs, GPU uploads, cube sharing, 2 replaced and 10 retained faces passed.')
