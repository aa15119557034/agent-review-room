'use strict';
const fs=require('fs'),p=require('path'),{pathToFileURL:u}=require('url'),{registerHooks}=require('module'),A=require('assert/strict'),z=require('zlib');
module.exports=async function inputs(){
 const f=p.resolve(__dirname,'../..'),vendor=p.join(f,'upstream/petalwake/vendor/three'),base=p.join(f,'.local/petalwake-25443cef0eba802052d9ef24c94ba3c4157b6f2e/assets'),url=x=>u(x).href,load=x=>import(url(p.join(f,x))),json=n=>JSON.parse(fs.readFileSync(n));
 registerHooks({resolve(s,c,next){if(s==='three')return{url:url(p.join(vendor,'build/three.module.js')),shortCircuit:true};if(s.startsWith('three/addons/'))return{url:url(p.join(vendor,'examples/jsm',s.slice('three/addons/'.length))),shortCircuit:true};return next(s,c);}});
 const T=await import('three'),{Terrain}=await load('upstream/petalwake/src/world/terrain.js'),{heightAt:stationY}=await load('upstream/sakuragaoka/src/world/layout.js'),{Props}=await load('upstream/petalwake/src/world/props.js');
 const tm=json(p.join(base,'terrain/meta.json')),hb=fs.readFileSync(p.join(base,'terrain/height.u16')),q=new Uint16Array(hb.buffer,hb.byteOffset,hb.length/2);
 const terrain=Object.create(Terrain.prototype);Object.assign(terrain,{N:tm.n,cell:tm.cell,h:Float32Array.from(q,v=>tm.hMin+v*((tm.hMax-tm.hMin)/65535)),heightTex:{},_buildMinMax(){}});
 terrain.flattenRect({minX:188,maxX:372,minZ:803,maxZ:1028,height:8,blend:32,surface:(x,z)=>8+stationY(T.MathUtils.clamp(x-280,-92,92),T.MathUtils.clamp(z-900,-97,128))-.08});
 const placements=json(p.join(base,'terrain/props.json')),loaded=[],stats={},range=(xs,k)=>[Math.min(...xs.map(v=>v[k])),Math.max(...xs.map(v=>v[k]))],reseated=[];
 const inRect=(x,z,m)=>x>=188-m&&x<=372+m&&z>=803-m&&z<=1028+m;
 for(const [name,xs] of Object.entries(placements)){
  const bytes=fs.readFileSync(p.join(base,'models',name+'.glb')),jsLen=bytes.readUInt32LE(12),doc=JSON.parse(bytes.subarray(20,20+jsLen)),bin=bytes.subarray(28+jsLen),prim=doc.meshes[0].primitives[0],info=json(p.join(base,'models',name+'.json'));
  const geometry=new T.BufferGeometry();for(const [n,k] of Object.entries(prim.attributes).filter(([n])=>['POSITION','_WIND'].includes(n))){
   const acc=doc.accessors[k],view=doc.bufferViews[acc.bufferView],size=n==='POSITION'?3:4,raw=new Float32Array(bin.buffer,bin.byteOffset+(view.byteOffset||0)+(acc.byteOffset||0),acc.count*size);A.equal(acc.componentType,5126);A(!view.byteStride||view.byteStride===size*4);geometry.setAttribute(n.toLowerCase(),new T.BufferAttribute(raw,size));if(n==='_WIND'){const a=Array.from({length:acc.count},(_,i)=>[raw[i*size],raw[i*size+1]]);stats.windR=range(a,0);stats.windG=range(a,1);}}
  const source=new T.Mesh(geometry,{map:null,normalMap:null,roughnessMap:null});const group=new T.Group();group.add(source);
  const list=xs.filter(([x,y,z,yaw,s])=>!inRect(x,z,s*info.radius)).map(row=>{if(!inRect(row[0],row[2],32))return row;const r=[row[0],terrain.heightAt(row[0],row[2]),...row.slice(2)];reseated.push({name,before:row,after:r});return r;});
  loaded.push({name,gltf:{scene:group},info,list});
 }
 const photos=json(p.join(f,'evidence/art-baseline-2026-11-18/report.json')).photos.pictures,cams={};
 for(const pose of Object.values(photos)){const c=new T.PerspectiveCamera(pose.fov,1.6,.2,16000);c.position.fromArray(pose.eye);c.lookAt(new T.Vector3().fromArray(pose.view.target));c.updateMatrixWorld();cams[pose.view.name]=c;}
 return{T,fixture:f,loaded,original:new Props(loaded),stats,reseated,cams,load};
};
