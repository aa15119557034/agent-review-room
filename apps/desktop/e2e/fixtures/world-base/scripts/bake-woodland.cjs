// Bake offline, using the MIT EZ-Tree 1.1.0 source unpacked into artifacts/alpine/package.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerHooks } = require('node:module');
const root = path.join(__dirname,'..');
const lib = path.join(root,'artifacts/alpine/package/src/lib');
const out = path.join(root,'src/woodland');
const three = pathToFileURL(path.join(root,'upstream/petalwake/vendor/three/build/three.module.js')).href;
const shim = code => 'data:text/javascript,'+encodeURIComponent(code);
registerHooks({resolve(id,context,next){
  if(id==='three') return {url:three,shortCircuit:true};
  if(id==='./textures') return {url:shim('export const getBarkTexture=()=>null,getLeafTexture=()=>null;'),shortCircuit:true};
  if(id==='./presets/index') return {url:shim('export const loadPreset=()=>{};'),shortCircuit:true};
  if(id.startsWith('./') && !path.extname(id)) return next(id+'.js',context);
  return next(id,context);
}});
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const {Tree} = await import(pathToFileURL(path.join(lib,'tree.js')).href);
  const materials=[], meshes=[], views=[], accessors=[], blocks=[];
  let bytes=0;
  function accessor(array,type,count,componentType,bounds){
    const raw=Buffer.from(array.buffer,array.byteOffset,array.byteLength);
    const id=views.push({buffer:0,byteOffset:bytes,byteLength:raw.length})-1;
    const pad=Buffer.alloc((4-raw.length%4)%4);
    blocks.push(raw,pad);bytes+=raw.length+pad.length;
    return accessors.push({bufferView:id,componentType,count,type,...bounds})-1;
  }
  for(const [species,preset,height] of [['oak','oak_medium',12],['aspen','aspen_medium',14],['pine','pine_medium',17],['ash','ash_small',9]]){
    for(let variant=0;variant<2;variant++){
      const cfg=JSON.parse(fs.readFileSync(path.join(lib,'presets',preset+'.json')));
      cfg.seed+=variant*3271;
      // Preserve each species' branching habit while budgeting cards per crown.
      cfg.branch.sections[0]=9;cfg.branch.segments[0]=7;
      for(let k=1;k<=3;k++){cfg.branch.sections[k]=4;cfg.branch.segments[k]=4;}
      cfg.branch.children[0]=Math.min(cfg.branch.children[0],species==='pine'?35:9);
      cfg.branch.children[1]=Math.min(cfg.branch.children[1],4);
      cfg.branch.children[2]=Math.min(cfg.branch.children[2],3);
      cfg.leaves.count=Math.min(cfg.leaves.count,species==='pine'?12:9);
      cfg.leaves.size*=species==='pine'?2.4:1.4;
      const tree=new Tree();tree.loadFromJson(cfg);
      const parts=[tree.branchesMesh.geometry,tree.leavesMesh.geometry];
      parts.forEach(g=>g.computeBoundingBox());
      const scale=height/Math.max(...parts.map(g=>g.boundingBox.max.y));
      const primitives=parts.map((g,k)=>{
        g.scale(scale,scale,scale);g.computeBoundingBox();
        const attr=g.attributes, norm=attr.normal, uv=attr.uv, pos=attr.position;
        const mat=species+(k?'-leaves':'-bark');
        if(!materials.some(m=>m.name===mat))materials.push({name:mat});
        return {attributes:{
          POSITION:accessor(pos.array,'VEC3',pos.count,5126,{min:g.boundingBox.min.toArray(),max:g.boundingBox.max.toArray()}),
          NORMAL:accessor(norm.array,'VEC3',norm.count,5126),
          TEXCOORD_0:accessor(uv.array,'VEC2',uv.count,5126)},
          indices:accessor(Uint16Array.from(g.index.array),'SCALAR',g.index.count,5123),
          material:materials.findIndex(m=>m.name===mat)};
      });
      meshes.push({name:species+variant,primitives});
    }
    fs.copyFileSync(path.join(lib,'assets/leaves',species+'_color.png'),path.join(out,species+'.png'));
  }
  for(const bark of ['oak','birch','pine'])fs.copyFileSync(path.join(lib,'assets/bark',bark+'_color_1k.jpg'),path.join(out,bark+'-bark.jpg'));
  fs.copyFileSync(path.join(lib,'../../LICENSE'),path.join(out,'LICENSE.txt'));
  const nodes=meshes.map((m,mesh)=>({name:m.name,mesh}));
  const doc={asset:{version:'2.0',generator:'EZ-Tree 1.1.0 / X-51'},scene:0,scenes:[{nodes:nodes.map((_,i)=>i)}],nodes,materials,meshes,buffers:[{byteLength:bytes}],bufferViews:views,accessors};
  const json=Buffer.from(JSON.stringify(doc)), jsonLength=(json.length+3)&~3;
  const header=Buffer.alloc(20),bin=Buffer.alloc(8);
  header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+jsonLength+bytes,8);
  header.writeUInt32LE(jsonLength,12);header.write('JSON',16);bin.writeUInt32LE(bytes);bin.write('BIN\0',4);
  fs.writeFileSync(path.join(out,'trees.glb'),Buffer.concat([header,json,Buffer.alloc(jsonLength-json.length,32),bin,...blocks]));
  console.log(meshes.map(m=>m.name+' '+m.primitives.reduce((n,p)=>n+accessors[p.indices].count/3,0)+' tris').join(', '));
})().catch(error=>{console.error(error);process.exitCode=1});
