const fix='/tmp/claude-0/wt254/apps/desktop/e2e/fixtures/world-base';
const {createStaticServer}=require(fix+'/scripts/baseline.cjs');
const {chromium}=require('playwright');const fs=require('fs');
(async()=>{
const out=process.argv[2];fs.mkdirSync(out,{recursive:true});
const variants=JSON.parse(process.argv[3]||'[["on","1"]]');
const srv=createStaticServer(fix);await new Promise(r=>srv.listen(8765,r));
const b=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:960,height:600}});
p.on('pageerror',e=>console.log('PAGEERR',e.message.slice(0,300)));
p.on('console',m=>{if(m.type()==='error')console.log('ERR',m.text().slice(0,300))});
const SI='/tmp/claude-0/x51/standin/';
await p.route('**/prop-assets/**',r=>{const u=r.request().url();let f=null;
 if(u.endsWith('.gltf'))f='crate.gltf';else if(u.includes('opacity'))f='opacity.png';else if(u.endsWith('textures/diff.png'))f='crate_diff.png';
 else if(u.endsWith('textures/arm.png'))f='arm.png';else if(u.endsWith('textures/nor.png'))f='nor.png';
 else if(u.includes('worn_shutter_diff'))f='shutter_diff.jpg';else if(u.includes('worn_shutter_nor'))f='shutter_nor.jpg';else if(u.includes('worn_shutter_arm'))f='shutter_arm.jpg';
 if(!f){console.log('NOSTANDIN',u);return r.continue();}
 r.fulfill({body:fs.readFileSync(SI+f),contentType:f.endsWith('gltf')?'model/gltf+json':f.endsWith('png')?'image/png':'image/jpeg'});});
await p.goto('http://localhost:8765/index.html');
await p.waitForFunction(()=>window.worldBase&&window.worldBase.ready,null,{timeout:900000});
await p.evaluate(()=>{window.requestAnimationFrame=()=>0;document.body.classList.add('hide-ui');});
console.log('SHADOWAUDIT',await p.evaluate(()=>{const w=window.worldBase;const out={};w.city.root.traverse(o=>{if(!o.isMesh)return;const k=(o.castShadow?'C':'c')+(o.receiveShadow?'R':'r')+':'+o.material.type;out[k]=(out[k]||0)+1;});return JSON.stringify(out);}));

console.log('CHECK',await p.evaluate(()=>{const w=window.worldBase;const out={};const rect=w.island.terrain.material.uniforms.uTownRect;
const mats=[];w.scene.traverse(o=>{if(o.isMesh&&o.material&&o.material.uniforms&&o.material.fragmentShader&&o.material.fragmentShader.includes('meadowTint('))mats.push(o);});
out.ground=mats.map(o=>o.name+':'+(o.material.uniforms.uTownRect===rect)+':'+o.material.fragmentShader.includes('wbTownMask(P.xz)'));
const M=w.island.meadow;const sh=M.shells;const m0=sh[0].material();out.ownMeadow=m0.uniforms.uTownRect===rect;m0.dispose();
const fresh=new M.constructor(w.island.terrain,'low');const m1=fresh.shells[0].material();out.freshMeadowPatched=!!m1.uniforms.uTownRect||m1.vertexShader.includes('wbTownMask');m1.dispose();
const fl=fresh.shells.find(s=>s.kind==='flower').material();out.freshFlowerPatched=fl.vertexShader.includes('wbTownMask');fl.dispose();
return JSON.stringify(out);}));
const views=[{name:'seam-central',fov:55,position:[5,3.2366846561431886,-105],target:[5,1.5048261889179049,-97.7]},{name:'seam-oblique',fov:55,position:[25,3.2205841700235998,-105],target:[18,1.5045947187946798,-97.7]}];
for(const [tag,expr] of variants){
 await p.evaluate(e=>{const w=window.worldBase;eval(e);w.renderer.shadowMap.needsUpdate=true;},expr);
 for(const v of views){const d=await p.evaluate(v=>{const w=window.worldBase;w.walker.setEnabled(false);w.camera.fov=v.fov||w.__fov||(w.__fov=w.camera.fov);if(!w.__fov)w.__fov=w.camera.fov;w.camera.updateProjectionMatrix();w.station.toWorld(w.camera.position.fromArray(v.position),w.camera.position);const t=w.camera.position.clone().fromArray(v.target);w.camera.lookAt(w.station.toWorld(t));w.camera.updateMatrixWorld();w.look.pipeline.hasPrev=false;w.renderer.setPixelRatio(1);for(let i=0;i<2;i++){w.island.update(0.016,10);w.look.render(w.scene,0.016);}return w.renderer.domElement.toDataURL('image/jpeg',0.9);},v);
 fs.writeFileSync(`${out}/${v.name}-${tag}.jpg`,Buffer.from(d.split(',')[1],'base64'));console.log('shot',v.name,tag);}
}
await b.close();srv.close();})().catch(e=>{console.error(e);process.exit(1)});
