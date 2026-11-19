import json,hashlib,sys
from pathlib import Path
archive=Path(__file__).resolve().parents[1]
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
read=lambda f:json.loads(f.read_bytes())
names=['src/world/houses/house.js','src/world/shopsA/common.js','src/world/station/building.js']
def audit(fixture,report):
    original=fixture/'.local'/('sakuragaoka-'+read(fixture/'sources.json')['sakuragaoka']['commit'])
    response=read(report)
    hashes={f['path']:f for f in response['transportAudit']['served']}
    manifest={v['path']:v['sha256'] for v in read(fixture/'source-files.json') if v['project']=='sakuragaoka'}
    result={}
    for n in names:
        k='/upstream/sakuragaoka/'+n
        entry=hashes[k]
        received=entry['wireSHA256']; tracked=sha(fixture/k[1:]); pinned=sha(original/n)
        assert entry['status']==200 and received==entry['sha256']==tracked
        assert pinned==manifest[n]
        result[n]={'vendored':tracked,'httpBody':received,'localOriginal':pinned,'pinnedOriginal':manifest[n]}
    return {'source':response['source'],'paths':result}
if __name__=='__main__':
    before,b_report,after,a_report=map(Path,sys.argv[1:5])
    out={'before':audit(before,b_report),'after':audit(after,a_report)}
    (archive/'upstream-transport.json').write_text(json.dumps(out,indent=2)+'\n')
    for k in names:
        a=out['after']['paths'][k]; b=out['before']['paths'][k]
        assert a['vendored']!=b['vendored'] and a['localOriginal']==b['localOriginal']
    print('All three edited modules matched their delivered bytes. The cached upstream originals matched the pinned hashes.')
