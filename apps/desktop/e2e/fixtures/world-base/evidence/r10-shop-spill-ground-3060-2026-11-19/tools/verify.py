"""Verify archived samples and original image digests. Takes no arguments."""
import gzip
import hashlib
import json
import math
from pathlib import Path

root=Path(__file__).resolve().parents[1]
def read(path): return json.loads((root/path).read_bytes())
def compressed(path): return json.loads(gzip.decompress((root/path).read_bytes()))
def digest(path): return hashlib.sha256((root/path).read_bytes()).hexdigest()
summary=read('summary.json')
for arm,commit in summary['sources'].items():
    receipts=compressed('receipts/photos-'+arm+'.json.gz')
    assert receipts['source']==commit and receipts['complete'] and receipts['transportAudit']['payloadIntegrityClean']
    for view,expected in summary['photos'][arm].items():
        assert digest(f'photos/{arm}/{view}.png')==expected==receipts['photos'][view]['hashes'][-1]
    assert digest(f'photos/{arm}/return-a.png')==receipts['photos']['return-a']['hashes'][-1]
total=0
for run in summary['timing']:
    tag=run['tag']; times=read(tag+'/frame-times.json'); raw=compressed(tag+'/frames.json.gz')
    assert digest(tag+'/frames.json.gz')==times['samples']['sha256'] and times['source']==run['source']
    for view,rows in raw.items():
        x=run['segments'][view]
        ms=sorted(p['ms'] for p in rows); n=len(ms); total+=n
        assert n==x['frames'] and math.isclose(sum(ms),x['durationMs'])
        assert math.isclose(1000*n/sum(ms),x['fps'])
        for rank in [95,99]: assert math.isclose(ms[math.ceil(n*rank/100)-1],x['p'+str(rank)+'Ms'])
        assert x['pass']==(x['fps']>=60 and x['p95Ms']<=16.7)
print(f'Validated 16 ground photos, 2 return-A checks and {total:,} timing samples.')
special=compressed('special/report.json.gz')
metrics=read('special/measurements.json')
for name,shot in special['photos'].items():
    hashes=[digest('special/'+name+'-'+tag+'.png') for tag in ('off','on','repeat-on')]
    assert hashes==shot['hashes']==metrics[name]['sha256'] and hashes[1]==hashes[2]
    if 'baselineSha256' in metrics[name]:
        assert digest('special/'+name+'-r9.png')==metrics[name]['baselineSha256']
    assert shot['glError']==0 and not shot['errors'] and 'RTX 3060 Laptop' in shot['gpu']
assert '1282 !== 0' in compressed('failed-77f28ef/report.json.gz')['failure']
print(f"Validated {len(metrics)} frozen toggle views and original failed capture.")
