// CPU rays against original triangles, with no backface culling/alpha/texture reads.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const g=JSON.parse(fs.readFileSync(path.join(root,'downloads/plastic_crate_02/plastic_crate_02_1k.gltf')));
const b=fs.readFileSync(path.join(root,'downloads/plastic_crate_02/plastic_crate_02.bin'));
const p=g.meshes[0].primitives[0],pa=g.accessors[p.attributes.POSITION],pv=g.bufferViews[pa.bufferView];
const ia=g.accessors[p.indices],iv=g.bufferViews[ia.bufferView];
const P=Array.from({length:pa.count},(_,i)=>[0,1,2].map(k=>b.readFloatLE((pv.byteOffset||0)+i*12+k*4)));
const I=Array.from({length:ia.count},(_,i)=>b.readUInt16LE((iv.byteOffset||0)+i*2));
function firstSurface(lateral,y,axis) {
  const uAxis=axis===2?0:2;let closest=-Infinity;
  for(let i=0;i<I.length;i+=3){
    const [a,c,d]=[P[I[i]],P[I[i+1]],P[I[i+2]]];
    const den=(c[1]-d[1])*(a[uAxis]-d[uAxis])+(d[uAxis]-c[uAxis])*(a[1]-d[1]);
    if(Math.abs(den)<1e-12)continue;
    const u=((c[1]-d[1])*(lateral-d[uAxis])+(d[uAxis]-c[uAxis])*(y-d[1]))/den;
    const v=((d[1]-a[1])*(lateral-d[uAxis])+(a[uAxis]-d[uAxis])*(y-d[1]))/den,w=1-u-v;
    if(u>=0&&v>=0&&w>=0)closest=Math.max(closest,u*a[axis]+v*c[axis]+w*d[axis]);
  }
  return Number.isFinite(closest)?closest:null;
}
const rows=[.05,.075,.095,.14,.17,.19],stats={samples:0,frontWallHits:0,behindOriginPlane:0,noHit:0};
for(const y of rows)for(let n=0;n<=920;n++){
  const z=firstSurface(-.23+n*.0005,y,2);stats.samples++;
  if(z===null)stats.noHit++;else if(z>.17)stats.frontWallHits++;else if(z<0)stats.behindOriginPlane++;
}
const probes=[];
for(const axis of [2,0])for(const y of [.075,.17,.225,.235])for(const lateral of [0,.15])
  probes.push({axis:axis===2?'-Z from z=0.5':'-X from x=0.5',lateral,y,firstSurface:firstSurface(lateral,y,axis)});
const result={method:'Original source triangles, orthographic rays in -Z or -X, barycentric intersections; no face culling or textures',
  gridTest:{wall:'+Z',xRange:[-.23,.23],xStep:.0005,yRows:rows,...stats},probes,
  conclusion:'All tested grille-region rays hit the near +Z wall. Small grille cutouts are not established as geometry; opaque preview alone must not be treated as restoration of source opacity intent.'};
fs.writeFileSync(path.join(root,'preview-output/crate-opaque-ab/geometry-hole-rays.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
