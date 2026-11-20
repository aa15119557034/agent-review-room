// CPU-only actual Sakuragaoka makeMaterials + batch2, with two flat-color CPU canvas textures.
import {writeFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,relative,resolve,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {registerHooks} from 'node:module';
import assert from 'node:assert/strict';
const home=dirname(fileURLToPath(import.meta.url)),fixture=resolve(home,'../../..'),mode=process.argv[2];
const refs={
 upstream:'26aafc09f355995789bc912d280d2b06874ae00f',
 raw:'880a02a762fd2d92f4c9c28c0c2bb5d6ac884157',
 stable:'5672dcbaaf337f782d9eb0fe62b14e54bc3d6f52',
 fixed:'ca10742c32074e84d621c4d890ee266842d7285c',
 final:'b4f1350397fc00b1ff7320f1844788dd1d16b86e'
};
if(!(mode in refs))throw Error('Use upstream, raw, stable, fixed, or final as the first argument.');
const source=refs[mode];
const url=p=>pathToFileURL(resolve(fixture,p)).href;
const file=url('src/toon.js'),prefix='apps/desktop/e2e/fixtures/world-base/';
registerHooks({
 resolve(spec,ctx,next){if(spec==='three')return{shortCircuit:true,url:url('upstream/petalwake/vendor/three/build/three.module.js')};if(spec.startsWith('three/addons/'))return{shortCircuit:true,url:url('upstream/petalwake/vendor/three/examples/jsm/'+spec.slice(13))};return next(spec,ctx);},
 load(u,ctx,next){
   if(!u.startsWith('file:'))return next(u,ctx);
   const rel=relative(fixture,fileURLToPath(u)).split(sep).join('/');
   if(!/^(src|upstream)\/.+\.js$/.test(rel))return next(u,ctx);
   return{shortCircuit:true,format:'module',source:execFileSync('git',['show',source+':'+prefix+rel],{cwd:fixture,encoding:'utf8',maxBuffer:32*1024*1024})};
 }
});
const THREE=await import('three');const toon=mode==='upstream'?null:await import(file);
if(mode!=='upstream')toon.installToonHook();
class Canvas {constructor(w=4,h=4,color=0){this.width=w;this.height=h;this.color=color;this.writes=new Map();}
 toDataURL(){return 'data:application/octet-stream;base64,'+Buffer.from(String(this.color)).toString('base64');}
 getContext(){return{drawImage:(s,x,y,w,h)=>{for(let j=0;j<h;j++)for(let i=0;i<w;i++)this.writes.set((y+j)*this.width+x+i,s.color);}}}
}
globalThis.HTMLCanvasElement=Canvas;globalThis.document={createElement(name){assert.equal(name,'canvas');return new Canvas();}};
const {createMaterials}=await import(url('upstream/sakuragaoka/src/core/materials.js'));
const {batchStatic}=await import(url('upstream/sakuragaoka/src/core/batch2.js'));
const {createSakuraMaterials}=await import(url('upstream/sakuragaoka/src/world/sakura/materials.js'));
const api=createMaterials({}),group=new THREE.Group();
const colors=[0xff4400,0x2288ff];
const textures=colors.map(c=>{const t=new THREE.CanvasTexture(new Canvas(4,4,c));t.colorSpace=THREE.SRGBColorSpace;return t;});
const regulars=[api.toon('#b82213'),api.toon('#2188ff'),...textures.map(t=>api.toon('#fefdfc',{map:t}))];
const named=new THREE.MeshToonMaterial();function fnA(s){s.a=true;}function fnB(s){s.b=true;}
named.onBeforeCompile=fnA;const wa=named.onBeforeCompile,keyA=named.customProgramCacheKey();named.onBeforeCompile=fnB;const wb=named.onBeforeCompile,keyB=named.customProgramCacheKey();
const sak=createSakuraMaterials({mat:api,shared:{uTime:{value:0},uSunDir:{value:null},uWind:{value:null},uGust:{value:0}},palette:api.palette},{});
[...regulars,sak.blob].forEach((m,i)=>{const o=new THREE.Mesh(new THREE.PlaneGeometry(1,1),m);o.position.set(3+i,0,4);group.add(o);});
const k=()=>({uniforms:{},fragmentShader:THREE.ShaderLib.toon.fragmentShader,vertexShader:THREE.ShaderLib.toon.vertexShader});const basic=k(),crown=k(),cards=k(),ordinary=k();
regulars[0].onBeforeCompile(ordinary);named.onBeforeCompile(basic);sak.blob.onBeforeCompile(crown);sak.cards.onBeforeCompile(cards);
const markers=[crown,cards].map(s=>/^#define TOON_NOLINE\s*$/m.test(s.fragmentShader));
const {foliageMaterial}=await import(url('upstream/sakuragaoka/src/world/lib/foliage.js'));
function invoke(callback) {
  const shader=k();
  try {
    callback(shader);
    return {ok:true,owner:shader.capturedOwner??null,paint:shader.uniforms.uPaint?.value??null,crown:/^#define TOON_NOLINE\s*$/m.test(shader.fragmentShader)};
  } catch(error) {
    return {ok:false,error:error.message};
  }
}
// The source generator really calls its previous hook as prev(shader,r).
const foliage=foliageMaterial({mat:api});
const realFoliage=invoke(shader=>foliage.onBeforeCompile(shader,{}));
const owner=new THREE.MeshToonMaterial();
owner.name='sakura:blob';
function captureOwner(shader){shader.capturedOwner=this?.name??null;}
owner.onBeforeCompile=captureOwner;
const detached=owner.onBeforeCompile;
const originalBare=invoke(shader=>detached(shader));
const clone=owner.clone();
clone.name='ordinary-clone';
clone.onBeforeCompile=owner.onBeforeCompile;
const transferred=clone.onBeforeCompile;
const cloneBare=invoke(shader=>transferred(shader));
const cloneMethod=invoke(shader=>clone.onBeforeCompile(shader,{}));
const explicitReceiver=invoke(shader=>transferred.call(owner,shader,{}));
const calls={realFoliage,originalBare,cloneBare,cloneMethod,explicitReceiver};
const cKey=sak.blob.customProgramCacheKey(),state={mode,source,regularIdsStable:regulars.every(m=>m.onBeforeCompile===m.userData.toon.obc),
  customReplaced:wa!==wb&&basic.b===true&&!basic.a,defaultCacheKeyDistinct:keyA!==keyB&&keyA===fnA.toString()&&keyB===fnB.toString(),customExcluded:sak.blob.onBeforeCompile!==sak.blob.userData.toon.obc,paintUnchanged:ordinary.uniforms.uPaint?.value===.05,customCacheKey:cKey,crownMaskDefines:markers};
state.calls=calls;
if(mode==='fixed'||mode==='final'){
  assert.ok(realFoliage.ok&&realFoliage.paint===.03);
  assert.ok(originalBare.ok&&originalBare.owner===owner.name&&originalBare.crown);
  for(const call of [cloneBare,cloneMethod])assert.ok(call.ok&&call.owner===clone.name&&!call.crown);
  assert.ok(explicitReceiver.ok&&explicitReceiver.owner===owner.name&&explicitReceiver.crown);
}
if(mode==='stable')assert.ok(!realFoliage.ok&&realFoliage.error.includes('name'));
if(mode!=='upstream'){
 const shared=ordinary.uniforms.uTbK===toon.toonLitUniforms.uTbK&&ordinary.uniforms.uTbRim===toon.toonLitUniforms.uTbRim&&crown.uniforms.uTbK===ordinary.uniforms.uTbK;
 toon.setToonLit(false);const closes=ordinary.uniforms.uTbK?.value===0&&crown.uniforms.uTbRim?.value===0;toon.setToonLit(true);
 state.uniformsShareAcrossPrograms=Boolean(shared&&closes&&ordinary.uniforms.uTbK.value===1);assert.ok(state.uniformsShareAcrossPrograms);
}
state.batch=batchStatic(group,{mat:api});const all=[];group.traverse(o=>{if(o.isMesh)all.push(o);});
state.resultMeshes=all.length;state.crownRetained=all.some(o=>o.material===sak.blob);const atlas=all.find(o=>o.material.map?.image?.width===4096);
state.atlasColors=atlas?Array.from(new Set(atlas.material.map.image.writes.values())).sort((a,b)=>a-b):[];
assert.ok(state.customExcluded&&state.crownRetained&&state.customReplaced&&state.defaultCacheKeyDistinct&&state.paintUnchanged);
if(mode==='raw'){assert.equal(state.regularIdsStable,false);assert.equal(state.batch.atlasTextures,0);assert.equal(state.resultMeshes,5);}
else {assert.equal(state.regularIdsStable,true);assert.equal(state.batch.atlasTextures,2);assert.equal(state.batch.atlasPages,1);assert.equal(state.batch.sharedMaterials,2);assert.equal(state.resultMeshes,3);assert.deepEqual(state.atlasColors,[...colors].sort((a,b)=>a-b));}
if(mode!=='upstream')assert.deepEqual(markers,[true,true]);
if(process.argv.includes('--save'))writeFileSync(resolve(home,mode+'.json'),JSON.stringify(state,null,2)+'\n');
console.log(JSON.stringify(state));
