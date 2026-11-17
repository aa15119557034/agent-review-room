import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const failures = [], loaded = [];
window.addEventListener('error', e => failures.push(String(e.message)));
window.addEventListener('unhandledrejection', e => failures.push(String(e.reason?.stack || e.reason)));
const manager = new THREE.LoadingManager();
manager.onError = url => failures.push('load: ' + url);
manager.onProgress = (url, count, total) => loaded.push({url,count,total});
const renderer = new THREE.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true});
renderer.setPixelRatio(1);
renderer.setSize(1440,900);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#cdd2d7');
// Small neutral studio gradient created only for this viewer; no external HDRI.
const envPixels = new Uint8Array(64*32*4);
for(let y=0;y<32;y++)for(let x=0;x<64;x++){
  const at=(y*64+x)*4,value=Math.round(155+65*(y/31));
  envPixels[at]=envPixels[at+1]=envPixels[at+2]=value;envPixels[at+3]=255;
}
const envSource=new THREE.DataTexture(envPixels,64,32,THREE.RGBAFormat);
envSource.mapping=THREE.EquirectangularReflectionMapping;envSource.colorSpace=THREE.SRGBColorSpace;envSource.needsUpdate=true;
const pmrem = new THREE.PMREMGenerator(renderer);
const environment = pmrem.fromEquirectangular(envSource);
scene.environment = environment.texture;
scene.environmentIntensity = .65;
envSource.dispose(); pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xffffff,0xbfc4ca,.8));
const key = new THREE.DirectionalLight(0xffffff,2.2);
key.position.set(-3,5,4); key.castShadow=true;
key.shadow.mapSize.set(1024,1024);
Object.assign(key.shadow.camera,{left:-3,right:3,top:3,bottom:-3,near:.1,far:15});
key.shadow.normalBias=.015;
scene.add(key);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshStandardMaterial({color:'#b5b8ba',roughness:1,metalness:0}));
ground.rotation.x=-Math.PI/2; ground.receiveShadow=true;scene.add(ground);
const camera = new THREE.PerspectiveCamera(38,1440/900,.01,100);
const gltfLoader = new GLTFLoader(manager),textureLoader = new THREE.TextureLoader(manager);
const assets = {};
for(const id of ['plastic_crate_02','painted_wooden_bench']) {
  const gltf = await gltfLoader.loadAsync(`/downloads/${id}/${id}_1k.gltf`);
  const group = gltf.scene;
  const box = new THREE.Box3().setFromObject(group);
  // Presentation transform only: original geometry/material/image data stay untouched.
  group.position.y -= box.min.y;
  group.visible=false;
  group.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
  scene.add(group); assets[id]=group;
}
const id='worn_shutter',base=`/downloads/${id}/textures/${id}`;
const [map,normalMap,arm] = await Promise.all([
  textureLoader.loadAsync(base+'_diff_1k.jpg'),textureLoader.loadAsync(base+'_nor_gl_1k.jpg'),textureLoader.loadAsync(base+'_arm_1k.jpg'),
]);
map.colorSpace=THREE.SRGBColorSpace;
normalMap.colorSpace=arm.colorSpace=THREE.NoColorSpace;
// Texture-only asset: a preview carrier, not a claim of an original shutter mesh.
const shutter = new THREE.Mesh(new THREE.PlaneGeometry(1.37,1.37),new THREE.MeshStandardMaterial({
  map,normalMap,aoMap:arm,roughnessMap:arm,metalnessMap:arm,metalness:1,roughness:1,normalScale:new THREE.Vector2(1,1),
}));
shutter.position.set(0,.685,0);shutter.castShadow=true;shutter.receiveShadow=true;shutter.visible=false;
scene.add(shutter);assets[id]=shutter;
const views={
  plastic_crate_02:{position:[.78,.61,.97],target:[0,.12,0]},
  painted_wooden_bench:{position:[1.62,1.08,1.95],target:[0,.43,0]},
  worn_shutter:{position:[.72,.94,2.15],target:[0,.685,0]},
};
function materialRecord(m) { return {name:m.name,type:m.type,color:m.color?.toArray(),opacity:m.opacity,transparent:m.transparent,
  alphaTest:m.alphaTest,side:m.side,depthWrite:m.depthWrite,metalness:m.metalness,roughness:m.roughness,
  map:!!m.map,normalMap:!!m.normalMap,aoMap:!!m.aoMap,roughnessMap:!!m.roughnessMap,metalnessMap:!!m.metalnessMap,
  normalScale:m.normalScale?.toArray(),normalColorSpace:m.normalMap?.colorSpace,mapColorSpace:m.map?.colorSpace,
  alphaMap:!!m.alphaMap,alphaMapFlipY:m.alphaMap?.flipY??null,alphaMapColorSpace:m.alphaMap?.colorSpace??null,
  alphaMapChannel:m.alphaMap?.channel??null}; }
window.previewAsset = async id => {
  for(const [name,asset]of Object.entries(assets))asset.visible=name===id;
  const view=views[id];camera.position.fromArray(view.position);camera.lookAt(...view.target);camera.updateMatrixWorld();
  renderer.compile(scene,camera);
  for(let i=0;i<5;i++){renderer.render(scene,camera);await new Promise(requestAnimationFrame);}
  renderer.render(scene,camera);
  const gl=renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
  const materials=[];assets[id].traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])materials.push(materialRecord(m));});
  return {id,three:THREE.REVISION,size:[1440,900],pixelRatio:renderer.getPixelRatio(),
    camera:{position:camera.position.toArray(),target:view.target,fov:camera.fov,near:camera.near,far:camera.far},
    renderer:{outputColorSpace:renderer.outputColorSpace,toneMapping:renderer.toneMapping,exposure:renderer.toneMappingExposure,
      webgl:gl.getParameter(gl.VERSION),vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),
      device:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),contextLost:gl.isContextLost(),error:gl.getError()},
    lighting:{hemisphere:.8,key:2.2,environment:'Viewer-only neutral grayscale gradient 64x32, SRGB 155..220, PMREM',environmentIntensity:.65},
    transform:{position:assets[id].position.toArray(),scale:assets[id].scale.toArray()},materials,failures:[...failures],loaded:[...loaded],
    note:'Independent neutral asset preview only. Not fixture acceptance or FPS evidence.'};
};
const crateMaterials=[];
assets.plastic_crate_02.traverse(object=>{
  if(object.isMesh)crateMaterials.push({object,original:object.material,adapted:null});
});
window.setCrateOpaquePreview = enabled => {
  for(const entry of crateMaterials){
    if(enabled){
      if(!entry.adapted){
        entry.adapted=entry.original.clone();
        entry.adapted.transparent=false;
        entry.adapted.depthWrite=true;
      }
      entry.object.material=entry.adapted;
    }else entry.object.material=entry.original;
  }
  return {enabled,changedProperties:['transparent','depthWrite'],originalMaterialRestored:!enabled};
};
let crateMask=null;
window.setCratePreviewMode = async mode => {
  if(mode!=='masked')return window.setCrateOpaquePreview(mode==='opaque');
  if(!crateMask){
    crateMask=await textureLoader.loadAsync('/supplemental/plastic_crate_02/textures/plastic_crate_02_opacity_1k.png');
    crateMask.flipY=false;crateMask.colorSpace=THREE.NoColorSpace;
    const source=crateMaterials[0].original.map;
    crateMask.wrapS=source.wrapS;crateMask.wrapT=source.wrapT;
    crateMask.minFilter=source.minFilter;crateMask.magFilter=source.magFilter;crateMask.channel=source.channel;
  }
  for(const entry of crateMaterials){
    if(!entry.masked){
      entry.masked=entry.original.clone();
      entry.masked.transparent=false;entry.masked.depthWrite=true;
      entry.masked.alphaMap=crateMask;entry.masked.alphaTest=.5;
    }
    entry.object.material=entry.masked;
  }
  return {mode:'masked',changedProperties:['transparent','depthWrite','alphaMap','alphaTest'],
    unchangedOtherMapReferences:crateMaterials.every(e=>['map','normalMap','roughnessMap','metalnessMap','aoMap'].every(key=>e.original[key]===e.masked[key])),
    sideUnchanged:crateMaterials.every(e=>e.original.side===e.masked.side),source:'official blend.1k opacity PNG'};
};
window.previewReady=true;
