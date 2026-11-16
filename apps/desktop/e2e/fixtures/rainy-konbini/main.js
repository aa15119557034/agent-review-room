import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { craft } from './craft.js';
import { buildStore } from './store.js';
import { buildStreet } from './street.js';
import { weather } from './weather.js';

const scene=new T.Scene();scene.fog=new T.Fog('#263348',30,68);
const renderer=new T.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.02;
renderer.outputColorSpace=T.SRGBColorSpace;document.body.appendChild(renderer.domElement);
const camera=new T.OrthographicCamera(-10,10,9,-9,.1,100);camera.position.set(18,14,22);camera.zoom=1.1;
const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,2.30,0);controls.enableDamping=true;controls.dampingFactor=.075;
controls.minZoom=.65;controls.maxZoom=4;controls.minPolarAngle=.22;controls.maxPolarAngle=1.47;controls.maxTargetRadius=7;controls.rotateSpeed=.65;controls.zoomSpeed=.8;controls.panSpeed=.7;controls.update();
const c=craft(scene);
scene.background=c.canvasTexture(2,512,(g,w,h)=>{const gradient=g.createLinearGradient(0,0,0,h);gradient.addColorStop(0,'#20253f');gradient.addColorStop(.65,'#35425a');gradient.addColorStop(1,'#242b43');g.fillStyle=gradient;g.fillRect(0,0,w,h);});
const hemi=new T.HemisphereLight('#9facdf','#242c43',.60);scene.add(hemi);
const moon=new T.DirectionalLight('#9db8eb',1.35);moon.position.set(-7,13,5);moon.castShadow=true;
moon.shadow.mapSize.set(2048,2048);moon.shadow.camera.left=-11;moon.shadow.camera.right=11;moon.shadow.camera.top=11;moon.shadow.camera.bottom=-11;moon.shadow.camera.far=35;moon.shadow.normalBias=.035;moon.shadow.bias=-.0003;scene.add(moon);
const rim=new T.DirectionalLight('#9a8dc3',.45);rim.position.set(9,8,-8);scene.add(rim);
const street=buildStreet(c),shop=buildStore(c);
const statistics=c.batchStatic(),effects=weather(scene,c,shop);
const bounds=new T.Box3().setFromObject(c.root);
const target=new T.WebGLRenderTarget(innerWidth,innerHeight,{samples:4,type:T.HalfFloatType});
const composer=new EffectComposer(renderer,target);composer.addPass(new RenderPass(scene,camera));
const bloom=new UnrealBloomPass(new T.Vector2(innerWidth,innerHeight),.16,.32,1.25);composer.addPass(bloom);composer.addPass(new OutputPass());
const resize=()=>{const aspect=innerWidth/innerHeight;camera.left=-9*aspect;camera.right=9*aspect;camera.top=9;camera.bottom=-9;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);composer.setSize(innerWidth,innerHeight);};resize();addEventListener('resize',resize);
let start=performance.now(),previous=start,frame=0;const frameTimes=[];
const audit={ready:false,scene,camera,controls,renderer,statistics,features:c.features,bounds:{min:bounds.min.toArray(),max:bounds.max.toArray()},effects,shop,street,elapsed:0,frameTimes,errors:[]};
window.rainyKonbini=audit;
addEventListener('error',e=>audit.errors.push(e.message));addEventListener('unhandledrejection',e=>audit.errors.push(String(e.reason)));
const colors=[new T.Color('#69c5a4'),new T.Color('#ebbe65'),new T.Color('#e88173')];
function animate(now){
  const t=(now-start)/1000,dt=now-previous;previous=now;if(frame++>15){frameTimes.push(dt);if(frameTimes.length>900)frameTimes.shift();}
  effects.update(t);
  // Periodic maintenance opening: no invisible person is needed in this empty diorama.
  const phase=t%26;let open=0;if(phase>12&&phase<14)open=T.MathUtils.smoothstep(phase,12,14);else if(phase>=14&&phase<17)open=1;else if(phase>=17&&phase<19)open=1-T.MathUtils.smoothstep(phase,17,19);
  shop.doorLeft.position.x=-.43-open*.78;shop.doorRight.position.x=.43+open*.78;
  shop.signLight.intensity=2.6*(.97+.025*Math.sin(t*.71)+(t%19>18.85?-.06:0));
  const state=Math.floor(t/8)%3;street.signalMats.forEach((mat,i)=>mat.color.copy(colors[i]).multiplyScalar(i===state?1.8:.16));
  controls.update();renderer.info.reset();composer.render();audit.ready=true;audit.elapsed=t;audit.doorOpening=open;requestAnimationFrame(animate);
}
renderer.info.autoReset=false;requestAnimationFrame(animate);
