import json, sys, hashlib
from pathlib import Path
import numpy as np
from PIL import Image
run, previous = map(Path,sys.argv[1:3])
r=json.loads((run/'bake-report.json').read_text(encoding='utf-8'))
assert r['bakeValid'] and r['encodingValid'] and r['sourceUnchanged'] and r['restore']['equal'] and len(r['faces'])==6
aggregate=[]
for face in r['faces']:
    name=face['name']; raw=(run/face['rawFile']).read_bytes(); png=(run/face['file']).read_bytes()
    assert hashlib.sha256(raw).hexdigest()==face['rawSha256'] and hashlib.sha256(png).hexdigest()==face['sha256']
    pixels=np.frombuffer(raw,dtype='<f2').reshape(256,256,4)[...,:3].astype('float64')
    assert np.isfinite(pixels).all() and pixels.min()>=0
    peak=np.max(pixels,axis=2); limited=peak>2
    mapped=pixels / np.maximum(1,peak[...,None]/2)
    assert mapped.max()<=2 and np.array_equal(mapped[~limited],pixels[~limited])
    x=mapped/2
    srgb=np.where(x<=.0031308,12.92*x,1.055*x**(1/2.4)-.055)
    expected=np.floor(srgb*255+.5).astype('uint8')
    with Image.open(run/face['file']) as im: actual=np.asarray(im.convert('RGBA'))
    assert np.array_equal(expected, actual[...,:3]) and (actual[...,3]==255).all()
    y=actual[...,:3].astype('float64')/255
    decoded=2*np.where(y<=.04045,y/12.92,((y+.055)/1.055)**2.4)
    err=float(np.max(np.abs(decoded-mapped)))
    assert err<.009 and np.abs(err-face['maxEncodingError'])<1e-8
    assert int(limited.sum())==face['limitedPixels']
    with Image.open(previous/(name+'.png')) as im: old=np.asarray(im.convert('RGB'))
    aggregate.append(dict(face=name,texels=int(peak.size),limited=int(limited.sum()),sourceMax=float(peak.max()),mappedMax=float(mapped.max()),decodedMax=float(decoded.max()),maxQuantizationError=err,differentFromAfternoon=int(np.any(old!=expected,axis=2).sum()),faceSha256=face['sha256'],sourceHDRsha256=face['rawSha256']))
print(json.dumps(dict(sourceHead=r['config']['head'],total=sum(a['texels'] for a in aggregate),limited=sum(a['limited'] for a in aggregate),sourceMax=max(a['sourceMax'] for a in aggregate),mappedMax=max(a['mappedMax'] for a in aggregate),maxQuantizationError=max(a['maxQuantizationError'] for a in aggregate),method='Every RGBA8 PNG pixel independently reconstructed from original float16. Unaffected HDR samples verified unchanged before quantization. Over-range colours scaled together in scene-linear RGB.',faces=aggregate),indent=2))
