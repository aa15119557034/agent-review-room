'use strict';
const fs=require('node:fs'),p=require('node:path'),a=require('node:assert/strict'),crypto=require('node:crypto'),init=require('./load-inputs.cjs');
const digest=v=>crypto.createHash('sha256').update(v).digest('hex'),subset=(candidate,reference)=>candidate.every(x=>reference.includes(x));
(async()=>{
 const {T,fixture,loaded,original,stats,reseated,cams,load}=await init(),{Props}=await load('upstream/petalwake/src/world/props.js'),{createPropCellCulling}=await load('src/island-prop-cells.js');
 const test=new Props(loaded),originalVertices=original.group.children.map((o,k)=>{o.computeBoundingSphere();return o.boundingSphere.clone();});
 const raw=test.group.children.map(o=>o.instanceMatrix.array.slice());const bytes=raw.reduce((sum,v)=>sum+v.byteLength,0),activeKeys=new Set();loaded.forEach((l,k)=>l.list.forEach(([x,y,z])=>activeKeys.add(k+'/'+Math.floor(x/384)+'/'+Math.floor(z/384))));
 const update=createPropCellCulling(test);a.deepEqual(test.counts,original.counts);a.equal(test.grid.size,original.grid.size);a.deepEqual([...test.grid],[...original.grid]);a(test.overlay.children[0].material.transparent&&!test.overlay.children[0].frustumCulled);a.equal(test.overlay.children[0].material.blending,original.overlay.children[0].material.blending);
 const objMatrices=raw.map(v=>Array.from({length:v.length/16},(_,i)=>Buffer.from(v.buffer,v.byteOffset+i*64,64).toString('hex')));
 const individual=original.group.children.map(o=>Array.from({length:o.count},(_,i)=>{const m=new T.Matrix4();o.getMatrixAt(i,m);const s=o.geometry.boundingSphere.clone().applyMatrix4(m);if(o.geometry.attributes._wind)s.radius+=.7;return s;}));
 a(stats.windR[0]>=0&&stats.windR[1]<=1&&stats.windG[0]>=0&&stats.windG[1]<=1);const winds=stats;
 const baseMaterial=original.group.children.map(o=>({transparent:o.material.transparent,outputAlphaOpaque:o.material.fragmentShader.includes('gl_FragColor = vec4(col, 1.0)'),instanceId:o.material.vertexShader.includes('gl_InstanceID'),casts:o.castShadow}));a(baseMaterial.every(m=>!m.transparent&&!m.casts&&!m.instanceId&&m.outputAlphaOpaque));
 let frameCount=0,instancesChecked=0,changes=0;const reference={};function inspect(camera,label){
  const prev=test.group.children.map(o=>o.instanceMatrix.version);update(camera);test.group.updateWorldMatrix(true,false);
  const clip=new T.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).multiply(test.group.matrixWorld),fr=new T.Frustum().setFromProjectionMatrix(clip,camera.coordinateSystem,camera.reversedDepth);
  const groups=[];test.group.children.forEach((mesh,k)=>{a(mesh.boundingSphere.equals(originalVertices[k]));const indices=[];for(let j=0;j<mesh.count;j++){const s=Buffer.from(mesh.instanceMatrix.array.buffer,mesh.instanceMatrix.array.byteOffset+j*64,64).toString('hex');indices.push(objMatrices[k].indexOf(s));}a(indices.every((v,j)=>v>=0&&(j===0||indices[j-1]<v)),'instances reordered or matrix changed');
   const keep=individual[k].flatMap((s,j)=>fr.intersectsSphere(s)?[j]:[]);a(subset(keep,indices),'false cull '+label+'/'+k);
   a.equal(mesh.instanceMatrix.array.byteLength,raw[k].byteLength);groups.push({name:loaded[k].name,source:raw[k].length/16,submitted:mesh.count,individualFrustum:keep.length,indices,triangles:mesh.count*loaded[k].info.tris});
   instancesChecked+=individual[k].length;if(mesh.instanceMatrix.version!==prev[k])changes++;
  });
  const now=test.group.children.map(o=>o.instanceMatrix.version);update(camera);a.deepEqual(now,test.group.children.map(o=>o.instanceMatrix.version),'static camera uploaded matrices');
  frameCount++;if(label)reference[label]={originalDraws:4,submittedDraws:groups.filter(g=>g.submitted>0).length,originalTriangles:loaded.reduce((sum,l)=>sum+l.info.tris*l.list.length,0),submittedTriangles:groups.reduce((sum,g)=>sum+g.triangles,0),groups};
 }
 const snapshots={};for(const [name,c] of Object.entries(cams)){inspect(c,name);snapshots[name]=test.group.children.map(o=>digest(Buffer.from(o.instanceMatrix.array.buffer,0,o.count*64)));}
 for(const [name,c] of Object.entries(cams)){inspect(c);a.deepEqual(test.group.children.map(o=>digest(Buffer.from(o.instanceMatrix.array.buffer,0,o.count*64))),snapshots[name]);}
 // Four calibrated eye heights, including back-facing directions and grazing planes.
 for(const c0 of Object.values(cams))for(let angle=0;angle<360;angle+=5)for(const pitch of [-.1,0,.1]){const c=c0.clone(),r=angle*Math.PI/180;c.lookAt(c.position.clone().add(new T.Vector3(Math.sin(r),pitch,Math.cos(r))));c.updateMatrixWorld();inspect(c);}
 test.group.position.set(8,4,-10);test.group.rotation.y=.35;for(const c of Object.values(cams))inspect(c);test.group.position.set(0,0,0);test.group.rotation.y=0;inspect(Object.values(cams)[0]);
 const slotted=Object.fromEntries(['lighthouse','menhir','boulders','tree'].map((key,k)=>[key,loaded[k].list.length]));
 const report={source:'363034ed1b6fa6c4ee7fbb05254156c937baf722',device:'CPU only; real GLB positions/wind and production placement/filter/reseating/Three r187. No renderer or GPU results.',cellMeters:384,totalBatches:activeKeys.size,originalInstances:slotted,sourceMatrixCpuBytes:bytes,additionalGpuBufferBytes:0,existingInstanceBufferSizes:raw.map(v=>v.byteLength),framesChecked:frameCount,instanceInclusivityChecks:instancesChecked,meshUploadMaskChanges:changes,registryOfOriginalCollisionBuckets:test.grid.size,wideSweep:'4 calibrated ground eyes × 72 headings × 3 nearby pitches, plus A-D re-entry and translated/rotated root checks. Every instance whose tree-padded individual sphere touched the frustum stayed in the compacted batch, authored order and each 64-byte matrix unchanged.',wind:{...winds,blankWake:true,inputWindDir:[.361,.933],shaderBoundMeters:Math.hypot(.361,.933)*Math.hypot(.44*.9,.1)+Math.sqrt(3)*.068,padding:2},materials:baseMaterial,reseated,views:reference};
 const expected=JSON.parse(fs.readFileSync(p.join(__dirname,'cpu-visibility.json')));a.deepEqual(report,expected);console.log('passed',frameCount,instancesChecked,bytes,activeKeys.size,JSON.stringify(Object.fromEntries(Object.entries(reference).map(([k,v])=>[k,[v.submittedDraws,v.originalTriangles-v.submittedTriangles,v.submittedTriangles]]))));
})().catch(e=>{console.error(e);process.exitCode=1});
