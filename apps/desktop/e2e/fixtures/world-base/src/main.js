import * as THREE from 'three';
import { createIsland } from './island.js';
import { createStation } from './station.js';
import { createLook } from './look.js';

const canvas = document.querySelector('#world');
const loadMessage = document.querySelector('#load-message');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.2, 16000);
camera.layers.enableAll();
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.localClippingEnabled = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.info.autoReset = false;

const worldBase = window.worldBase = {
  ready: false, renderer, camera, scene, errors: [], stages: [], views: [],
  revision: THREE.REVISION, cameraMode: 'third', currentView: 'station-street',
};
function stage(message) {
  loadMessage.textContent = message;
  worldBase.stages.push({ message, ms: performance.now() });
  console.info('[world-base]', message);
}
function fail(error) {
  const message = error?.stack || String(error);
  worldBase.errors.push(message);
  console.error(message);
  loadMessage.textContent = `加载失败：${error?.message || error}`;
  document.querySelector('#loading').hidden = false;
}
window.addEventListener('error', event => fail(event.error || event.message));
window.addEventListener('unhandledrejection', event => fail(event.reason));

const look = createLook(renderer, camera);
worldBase.look = look;
worldBase.styleState = { toon: true, flightEffects: false };
let island, station, walker;
const toWorld = (values) => station.toWorld(new THREE.Vector3(...values)).toArray();
const labels = { 'station-street': '车站区街道', 'station-port': '车站望向港镇', 'island-aerial': '全岛俯视', 'shop-interior': '便利店室内' };
function setView(name) {
  const view = worldBase.views.find(item => item.name === name);
  if (!view) throw new Error(`Unknown fixed camera: ${name}`);
  walker.setEnabled(false);
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  camera.position.fromArray(view.position);
  camera.lookAt(new THREE.Vector3(...view.target));
  camera.updateMatrixWorld();
  worldBase.currentView = name;
  look.pipeline.hasPrev = false;
  document.querySelector('#mode').textContent = labels[name];
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  document.querySelector('#walk').textContent = '进入步行';
}
worldBase.setView = setView;
function startWalking() {
  walker.setPose(station.spawn, 4, -8);
  walker.setEnabled(true);
  walker.setView(worldBase.cameraMode);
  worldBase.currentView = 'walking';
  document.querySelector('#mode').textContent = '步行 · 车站区';
  document.querySelector('#walk').textContent = '回到街道';
  document.querySelectorAll('[data-view]').forEach(button => button.classList.remove('active'));
  canvas.focus();
}
worldBase.startWalking = startWalking;
worldBase.setToon = value => { look.setToon(value); worldBase.styleState.toon = !!value; document.querySelector('#toon').checked = !!value; };
worldBase.setFlightEffects = value => { look.setFlightEffects(value); worldBase.styleState.flightEffects = !!value; document.querySelector('#effects').checked = !!value; };

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  look.setSize(innerWidth, innerHeight, renderer.getPixelRatio());
}
addEventListener('resize', resize);
resize();

async function init() {
  stage('正在读取岛屿地形、港镇和云层…');
  island = await createIsland({ scene, renderer, camera });
  worldBase.island = island;
  look.applyIsland(island);
  const sun = new THREE.DirectionalLight(0xffefd9, 2.1);
  sun.position.copy(island.U.uSunDir.value).multiplyScalar(160).add(new THREE.Vector3(...island.stationPlacement.position));
  sun.target.position.set(...island.stationPlacement.position);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.layers.enableAll();
  Object.assign(sun.shadow.camera, { left: -100, right: 100, top: 105, bottom: -105, near: 1, far: 400 });
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.035;
  scene.add(sun, sun.target, new THREE.HemisphereLight(0xc6d8ff, 0x9c87a5, 1.2));
  stage('正在安放车站、店铺与碰撞体…');
  station = await createStation({
    scene, renderer, camera, offset: island.stationPlacement.position,
    rotationY: island.stationPlacement.rotationY, sunDir: island.U.uSunDir.value,
    onProgress: stage,
  });
  worldBase.station = station;
  walker = station.createWalker(canvas);
  worldBase.walker = walker;
  worldBase.views = [
    { name: 'station-street', position: toWorld([-1.2, 2.4, 36]), target: toWorld([0, 2.0, -25]) },
    { name: 'station-port', position: toWorld([-65, 15, -28]), target: [-45, 21, 1036] },
    { name: 'island-aerial', position: [2100, 2350, 2450], target: [-150, 70, -150] },
    { name: 'shop-interior', position: toWorld([-8.3, 1.9134, 8]), target: toWorld([-12.8, 1.7134, 8]) },
  ];
  setView('station-street');
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  document.querySelector('#walk').addEventListener('click', () => walker.enabled ? setView('station-street') : startWalking());
  document.querySelector('#camera').addEventListener('click', () => {
    worldBase.cameraMode = walker.view === 'third' ? 'first' : 'third';
    walker.setView(worldBase.cameraMode);
  });
  document.querySelector('#toon').addEventListener('change', event => worldBase.setToon(event.target.checked));
  document.querySelector('#effects').addEventListener('change', event => worldBase.setFlightEffects(event.target.checked));
  addEventListener('keydown', event => {
    if (event.code === 'KeyH') document.body.classList.toggle('hide-ui');
    const view = worldBase.views[Number(event.key) - 1];
    if (view) setView(view.name);
  });
  stage('场景已就绪');
  document.querySelector('#loading').hidden = true;
  let last = performance.now(), sampleStart = last, samples = 0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    try {
      renderer.info.reset();
      station.update(dt, now / 1000, walker.worldPosition);
      walker.update(dt);
      island.update(dt, now / 1000);
      look.render(scene, dt);
      worldBase.ready = true;
      worldBase.cameraMode = walker.view;
      document.querySelector('#camera').textContent = `${walker.view === 'first' ? '第一' : '第三'}人称 · V`;
      samples++;
      if (now - sampleStart >= 700) {
        const fps = 1000 * samples / (now - sampleStart);
        worldBase.frameStats = { fps, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
        document.querySelector('#performance').textContent = `${fps.toFixed(0)} FPS · ${(renderer.info.render.triangles / 1e6).toFixed(2)} M tris`;
        sampleStart = now; samples = 0;
      }
      requestAnimationFrame(frame);
    } catch (error) { fail(error); }
  }
  requestAnimationFrame(frame);
}
init().catch(fail);
