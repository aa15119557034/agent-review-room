import * as THREE from 'three';
import { createIsland, clearVegetationAreas } from './island.js';
import { loadShadowTint, shadowTintEnabled, installLitShadowTint, patchIslandShadowTint, shadowTintUniforms, shopInteriorBox } from './shadow-tint.js';
import { applyEveningGlow, applyEveningSakura, fadeDistantCrossingHalos } from './evening-glow.js';
import * as layoutModule from '../upstream/sakuragaoka/src/world/layout.js';
import { createStation } from './station.js';
import { basins, basinAt, bankView } from './basins.js';
import { createRain } from './rain.js';
import { createLook } from './look.js';
import { createSkyline } from './skyline.js';
import { coastWalking } from './coast.js';
import { createCity } from './city.js';
import { applyWeathering, loadWeatheringParams } from './weathering.js';
import { addWeatheringDecals, loadBakedDecals } from './weathering-decals.js';

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
let returnView = 'station-street';
const toWorld = (values) => station.toWorld(new THREE.Vector3(...values)).toArray();
const labels = { 'station-street': '车站区街道', 'station-port': '车站望向港镇', 'island-aerial': '全岛俯视', 'shop-interior': '便利店室内', 'service-corner': '车站服务角', 'laundry-details': '洗衣店前细节' };
function setView(name) {
  const view = worldBase.views.find(item => item.name === name);
  if (!view) throw new Error(`Unknown fixed camera: ${name}`);
  walker.setEnabled(false);
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  camera.fov = view.fov;
  camera.updateProjectionMatrix();
  camera.position.fromArray(view.position);
  camera.lookAt(new THREE.Vector3(...view.target));
  camera.updateMatrixWorld();
  worldBase.currentView = name;
  look.pipeline.hasPrev = false;
  document.querySelector('#mode').textContent = labels[name];
  document.querySelector('#water-view').value = view.feet ? name : '';
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  document.querySelector('#walk').textContent = '进入步行';
}
worldBase.setView = setView;
function startWalking() {
  camera.fov = 58;
  camera.updateProjectionMatrix();
  const bank=worldBase.views.find(view=>view.name===worldBase.currentView && view.feet);
  returnView = bank?.name ?? (worldBase.currentView === 'coast' ? 'coast' : 'station-street');
  if(bank) walker.setPose(new THREE.Vector3(...bank.feet),bank.yaw,-7);
  else if (returnView === 'coast') {
    const feet = new THREE.Vector3(287, island.heightAt(287, 1110), 1110);
    walker.setPose(feet, 110, -4);
  } else walker.setPose(station.spawn, 4, -8);
  walker.setEnabled(true);
  walker.setView(worldBase.cameraMode);
  worldBase.currentView = 'walking';
  document.querySelector('#mode').textContent = '步行';
  document.querySelector('#walk').textContent = bank ? '回到水边' : returnView === 'coast' ? '回到海岸' : '回到街道';
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
  // ?time=afternoon keeps Petalwake's original light for before/after comparison.
  const timeOfDay = new URLSearchParams(location.search).get('time') ?? 'evening';
  // Round 24: blue-violet shade. The lit-material chunk is patched before any program compiles.
  const shadowTintParams = shadowTintEnabled() ? await loadShadowTint() : null;
  const shadowTint = shadowTintParams ? shadowTintParams[timeOfDay === 'afternoon' ? 'afternoon' : 'evening'] : null;
  island = await createIsland({ scene, renderer, camera, timeOfDay });
  worldBase.island = island;
  look.applyIsland(island);
  if (shadowTint) worldBase.shadowTint = { island: patchIslandShadowTint(island, shadowTint) };
  const evening = island.timeOfDay === 'evening';
  // Low golden-hour sun: warmer and a little weaker; the sky fill turns cooler so shade reads blue-violet.
  const sun = new THREE.DirectionalLight(evening ? 0xffc490 : 0xffe4c4, evening ? 2.3 : 2.1);
  sun.position.copy(island.U.uSunDir.value).multiplyScalar(160).add(new THREE.Vector3(...island.stationPlacement.position));
  sun.target.position.set(...island.stationPlacement.position);
  sun.castShadow = true;
  // One cascade covers the station and the town edge behind it (local z≈-140);
  // 4096 over ±150 m keeps the street at ~7 cm/texel (was ~10 cm at 2048/±105).
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.layers.enableAll();
  Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 1, far: 400 });
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.035;
  const skyFill = evening ? new THREE.HemisphereLight(0xb4bce8, 0xa08068, 1.6) : new THREE.HemisphereLight(0xcfe0ff, 0xa89c94, 1.05);
  const clearSun = sun.intensity, clearFill = skyFill.intensity;
  scene.add(sun, sun.target, skyFill);
  stage('正在安放车站、店铺与碰撞体…');
  station = await createStation({
    scene, renderer, camera, offset: island.stationPlacement.position,
    rotationY: island.stationPlacement.rotationY, sunDir: island.U.uSunDir.value, evening,
    groundMaterial: island.transition.material,
    onProgress: stage,
  });
  worldBase.station = station;
  if (shadowTint) {
    // No program using the lit chunk has compiled yet (first render is after init), so the box can be known here.
    const box = shopInteriorBox(layoutModule, station, shadowTintParams.indoorPad);
    installLitShadowTint(shadowTint, box);
    look.setShadowTint(shadowTintUniforms(shadowTint), box, shadowTintParams.indoorFade);
    worldBase.shadowTint.indoorBox = box;
  }
  // Interpolate the existing ramp values for softer boundaries between tones.
  const ramp = station.ctx.mat.gradientMap;
  ramp.magFilter = ramp.minFilter = THREE.LinearFilter;
  ramp.needsUpdate = true;
  worldBase.skyline = createSkyline({ scene, station, island });
  worldBase.skyline.vegetationClear = clearVegetationAreas(island.terrain,
    worldBase.skyline.vegetationClearAreas, station.root.matrixWorld);
  stage('正在安放站后建筑…');
  worldBase.city = await createCity({ scene, station, island, skyline: worldBase.skyline });
  worldBase.city.vegetationClear = clearVegetationAreas(island.terrain,
    worldBase.city.vegetationClearAreas, station.root.matrixWorld, { flowers: 8, jitter: 2.5 });
  island.meadow._buildCoverGrid(); // Refresh the density cache before its first update.
  {
    // Town greenery covers the lots, their connections and planting (station frame, no rotation).
    const areas = worldBase.city.vegetationClearAreas, o = station.root.position;
    const rect = [Infinity, Infinity, -Infinity, -Infinity];
    for (const a of areas) { rect[0] = Math.min(rect[0], a.minX); rect[1] = Math.min(rect[1], a.minZ); rect[2] = Math.max(rect[2], a.maxX); rect[3] = Math.max(rect[3], a.maxZ); }
    if (island.stationPlacement.rotationY !== 0 || !areas.length) throw new Error('Town greenery expects an unrotated, non-empty town');
    worldBase.townGreenRect = [rect[0] + o.x, rect[1] + o.z, rect[2] + o.x, rect[3] + o.z];
    look.setTownGreenery(worldBase.townGreenRect);
  }
  walker = station.createWalker(canvas, coastWalking(station, island));
  worldBase.walker = walker;
  worldBase.views = [
    { name: 'station-street', fov: 58, position: toWorld([-1.2, 2.4, 36]), target: toWorld([0, 2.0, -25]) },
    { name: 'station-port', fov: 58, position: toWorld([-65, 15, -28]), target: [-45, 21, 1036] },
    { name: 'island-aerial', fov: 58, position: [2100, 2350, 2450], target: [-150, 70, -150] },
    { name: 'shop-interior', fov: 58, position: toWorld([-8.3, 1.9134, 8]), target: toWorld([-12.8, 1.7134, 8]) },
    { name: 'service-corner', fov: 55, position: toWorld(station.texturedProps.stats.view.position), target: toWorld(station.texturedProps.stats.view.target) },
    { name: 'laundry-details', fov: 55, position: toWorld(worldBase.city.stats.texturedProps.view.position), target: toWorld(worldBase.city.stats.texturedProps.view.target) },
    { name: 'coast', fov: 58, position: [270, island.heightAt(270, 1110) + 1.65, 1110], target: [-55, 3, 1230] },
  ];
  const waterSelect=document.querySelector('#water-view');
  for(const b of basins){
    worldBase.views.push(bankView(b,island.terrain));
    labels[b.id]=b.name;
    waterSelect.add(new Option(b.name,b.id));
  }
  worldBase.views.push(island.streamView);labels.stream='山溪 · 砾石滩';
  waterSelect.add(new Option(labels.stream,'stream'));
  waterSelect.addEventListener('change',()=>{ if(waterSelect.value) setView(waterSelect.value); });
  const pointer=new THREE.Vector2(), caster=new THREE.Raycaster();
  let press;
  canvas.addEventListener('pointerdown',e=>{if(e.button===0) press=[e.clientX,e.clientY];});
  canvas.addEventListener('pointerup',e=>{
    if(!press || e.button!==0) return;
    const moved=Math.hypot(e.clientX-press[0],e.clientY-press[1]);press=null;
    if(moved>4) return;
    const rect=canvas.getBoundingClientRect();
    pointer.set(2*(e.clientX-rect.left)/rect.width-1,1-2*(e.clientY-rect.top)/rect.height);
    caster.setFromCamera(pointer,camera);
    island.inland.splashRay(caster.ray);
  });
  labels.coast = '南岸 · 潮间带';
  setView('station-street');
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  document.querySelector('#walk').addEventListener('click', () => walker.enabled ? setView(returnView) : startWalking());
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
  if (island.timeOfDay === 'evening') {
    worldBase.eveningGlow = applyEveningGlow(scene, look);
    worldBase.eveningSakura = applyEveningSakura(scene);
    worldBase.crossingHalos = fadeDistantCrossingHalos(scene);
  }
  // Round 22: wall weathering + posters. After the evening glow, so emissive materials are already known.
  {
    const weatheringStart = performance.now();
    const params = await loadWeatheringParams();
    worldBase.weathering = applyWeathering({ scene, station, island, city: worldBase.city, skyline: worldBase.skyline, params, timeOfDay: island.timeOfDay });
    worldBase.weatheringDecals = addWeatheringDecals({ scene, station, wallMaterials: worldBase.weathering.wallMaterials,
      roots: [station.root, worldBase.city.root, worldBase.skyline.root], gradientMap: station.ctx.mat.gradientMap, explicit: params.decals.explicit,
      baked: await loadBakedDecals(), forcePlan: new URLSearchParams(location.search).get('decals') === 'plan' });
    worldBase.weatheringMs = +(performance.now() - weatheringStart).toFixed(1);
    // ?weathering=off keeps the previous look for before/after captures.
    if (new URLSearchParams(location.search).get('weathering') === 'off') { worldBase.weathering.setEnabled(false); worldBase.weatheringDecals.setEnabled(false); }
  }
  stage('场景已就绪');
  document.querySelector('#loading').hidden = true;
  const rain=createRain(scene,renderer,station);
  const mirrorOmit=[island.water.mesh,island.river.group,island.sky.mesh,rain.streaks];
  let sceneStart, weatherOffset=0;
  const weatherStart=document.querySelector('#weather-start');
  weatherStart.addEventListener('change',()=>{
    weatherOffset=Number(weatherStart.value);
    sceneStart=performance.now();
    weatherStart.value='';
  });
  let last = performance.now(), sampleStart = last, samples = 0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    try {
      renderer.info.reset();
      island.weather.update(weatherOffset+(sceneStart === undefined ? 0 : Math.max(0,(now-sceneStart)/1000)));
      const cover = island.weather.state.cover;
      sun.intensity = clearSun * (1 - 0.66 * cover);
      skyFill.intensity = clearFill * (1 + 0.13 * cover);
      station.streetReflections.uniforms.uStreetOvercast.value = cover;
      station.wetRoad.rainFilm.value=island.weather.state.wetness;
      rain.update(island.weather.state.rain);
      look.setGroundFog(island.weather.state.fog);
      station.update(dt, now / 1000, walker.worldPosition);
      walker.update(dt);
      island.inland.update(dt,island.weather.state,walker.enabled ? walker.worldPosition : null,camera.position);
      island.update(dt, now / 1000);
      island.inland.reflection.update(renderer,scene,camera,basinAt(camera.position.x,camera.position.z,1.5),mirrorOmit,now/1000);
      look.render(scene, dt);
      sceneStart ??= performance.now(); // Start after first-frame compilation.
      worldBase.ready = true;
      worldBase.cameraMode = walker.view;
      document.querySelector('#camera').textContent = `${walker.view === 'first' ? '第一' : '第三'}人称 · V`;
      samples++;
      if (now - sampleStart >= 700) {
        const fps = 1000 * samples / (now - sampleStart);
        worldBase.frameStats = { fps, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
        document.querySelector('#performance').textContent = `${fps.toFixed(0)} FPS · ${(renderer.info.render.triangles / 1e6).toFixed(2)} M tris`;
        document.querySelector('#weather').textContent=island.weather.state.phase;
        sampleStart = now; samples = 0;
      }
      requestAnimationFrame(frame);
    } catch (error) { fail(error); }
  }
  requestAnimationFrame(frame);
}
init().catch(fail);
