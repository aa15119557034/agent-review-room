"""Source-level facts about house porch support and shader intensity. No assumptions about adjacent scene geometry."""
import json,subprocess,sys
from pathlib import Path
folder=Path(sys.argv[1]).resolve()
commit='4d94a1f41d17f18628e90e2c3f03914e37a3e471'
prefix='apps/desktop/e2e/fixtures/world-base/'
def source(rel):
    return subprocess.check_output(['git','-c','safe.directory='+folder.as_posix(),'-C',str(folder),'show',commit+':'+prefix+rel]).decode()
house=source('upstream/sakuragaoka/src/world/houses/house.js')
glow=source('src/door-glow.js')
assert 'const pw = dw + 1.1, pd = S.door.porchD || 1.25' in house
assert 'const lx = du + ls * (dw / 2 + 0.32)' in house
assert 'pd, du, gFront - 0.12, pd / 2' in house
for expr in ['scale.set(2 * rad, slab, 1)','new THREE.Vector2(...rad)','pos.y = l.floor + 0.012','pow( 1.0 - smoothstep( 0.0, 1.0, r ), uPow )','[0.8, 1], true']:
    assert expr in glow
params=json.loads(source('src/evening.json'))['doorGlow']
half_gap=1.1/2-.32
def weight(x):
    u=min(1,abs(x)/params['floorRadius'])
    return (1-u*u*(3-2*u))**params['falloff']
report={'source':commit,'wallSize':params['wallSize'],'wallOffset':params['wallOffset'],'poolCenterOut':params['floorOut'],'radius':params['floorRadius'],'strength':params['floor'],'color':params['color'],'floorPlaneHeightOffset':.012,
        'lateralDistanceFromLampToNearSideOfOwnHousePorch':half_gap,
        'crossSectionAtPoolCenter':[{'xOffset':x,'pastOwnPorchEdge':x-half_gap,'shaderWeight':weight(x),'additiveLinearRGB':[round(c*params['floor']*weight(x),6) for c in params['color']]} for x in [.23,.4,.65,1.2]],
        'scope':'Horizontal support by registered house porch only. Neighboring surfaces and occlusion require scene rays.'}
out=Path(__file__).resolve().parents[1]/'shader-support.json'
out.write_text(json.dumps(report,indent=2)+'\n')
print(report['crossSectionAtPoolCenter'])
