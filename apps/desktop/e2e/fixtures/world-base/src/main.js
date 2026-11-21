import * as THREE from 'three';
import { createIsland, clearVegetationAreas } from './island.js';
import { loadShadowTint, shadowTintEnabled, installLitShadowTint, patchIslandShadowTint, shadowTintUniforms, shopInteriorBoxes } from './shadow-tint.js';
import { loadToon, toonEnabled, gradeEnabled, applyForm, installLitToon, installToonHook, toonLineUniforms, maskGlassAlpha, signLinesEnabled, markSignMaterials, installFlatColour, toonFlatUniforms } from './toon.js';
import { addShopSpill, loadShopSpill, shopFrontsFromRooms, groundSpillFronts } from './shop-spill.js';
import { addDoorGlow, loadDoorGlow, resolveDoorLamps } from './door-glow.js';
import { applyEveningGlow, applyEveningSakura, fadeDistantCrossingHalos } from './evening-glow.js';
import * as layoutModule from '../upstream/sakuragaoka/src/world/layout.js';
import { createStation } from './station.js';
import { reflEnabled, bakeStreetZones, createReflControl } from './street-zones.js';
import { createLook } from './look.js';
import { createSkyline } from './skyline.js';
import { createCity } from './city.js';
import { massingEnabled, loadMassing, createMassing } from './massing.js';
import { blocksEnabled, applyBlocksParams, createFacadeBlocks } from './facade-blocks.js';
import { towersEnabled, createTowerBlocks } from './tower-blocks.js';
import { makeShared } from './block-common.js';
import { midbandEnabled, layoutMidband } from './midband-blocks.js';
import { applyWeathering, loadWeatheringParams } from './weathering.js';
import { addWeatheringDecals, loadBakedDecals } from './weathering-decals.js';
import { groundEnabled, loadGround, applyFlowerDrifts, patchGroundShader, patchPetals } from './island-ground.js';
import { getMats as getVehicleMats } from '../upstream/sakuragaoka/src/world/vehicles/atlas.js';

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

if (toonEnabled()) installToonHook(); // round 28: before any material exists
const look = createLook(renderer, camera);
worldBase.look = look;
worldBase.styleState = { toon: true, flightEffects: false };
let island, station, walker;
let skyFill;
let originalFillColor, toonFillColor;
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
  document.querySelector('#mode').textContent = view.label ?? labels[name];
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  document.querySelector('#walk').textContent = '进入步行';
}
worldBase.setView = setView;
function startWalking() {
  camera.fov = 58;
  camera.updateProjectionMatrix();
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
worldBase.setToon = value => {
  look.setToon(value);
  if (toonFillColor) skyFill.color.copy(value ? toonFillColor : originalFillColor);
  worldBase.styleState.toon = !!value;
  document.querySelector('#toon').checked = !!value;
};
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
  // 阴影更新策略。默认 every30（每 30 帧重烘一次，实测与静态同速，但会动物体阴影跟得上）。
  //   ?shadow=dynamic  回到旧行为（每帧重渲）
  //   ?shadow=static   只渲一次
  //   ?shadowEvery=N   每 N 帧重渲一次（配合 static 或单独用）
  const shadowQuery = new URLSearchParams(location.search);
  const shadowMode = shadowQuery.get('shadow') ?? 'every30';
  const shadowStatic = shadowMode === 'static';
  // static 是真·只渲一次；dynamic 每帧；其余按 shadowEvery（默认 30）
  const shadowEvery = (shadowStatic || shadowMode === 'dynamic')
    ? 0
    : Math.max(1, Number(shadowQuery.get('shadowEvery') ?? 30) | 0);
  // Round 24: blue-violet shade. The lit-material chunk is patched before any program compiles.
  const shadowTintParams = shadowTintEnabled() ? await loadShadowTint() : null;
  const shadowTint = shadowTintParams ? shadowTintParams[timeOfDay === 'afternoon' ? 'afternoon' : 'evening'] : null;
  island = await createIsland({ scene, renderer, camera, timeOfDay });
  worldBase.island = island;
  // Art round 2: island-wide ground (flower drifts, pastel petals, painted sward and rock). ?ground=off skips it.
  const groundParams = groundEnabled() ? await loadGround() : null;
  if (groundParams) {
    worldBase.ground = { drifts: applyFlowerDrifts(island.terrain, island.terrain.meta.world ?? 6144, groundParams.drift) };
    island.meadow.wbPetals = (vertexShader) => patchPetals(vertexShader, groundParams);
  }
  look.applyIsland(island);
  if (groundParams) for (const [material, label] of [[island.terrain.material, 'terrain'], [island.transition.material, 'transition']]) patchGroundShader(material, groundParams, label);
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
  skyFill = evening ? new THREE.HemisphereLight(0xb4bce8, 0xa08068, 1.6) : new THREE.HemisphereLight(0xcfe0ff, 0xa89c94, 1.05);
  scene.add(sun, sun.target, skyFill);
  stage('正在安放车站、店铺与碰撞体…');
  // Art round 22: zoned street cubes + vertical neon streaks on the wet road. toon.json "refl" (absent / on:0 = off);
  // ?refl=old or ?toon=off keeps round 21 pixel for pixel (nothing is installed or baked).
  const reflParams = toonEnabled() && reflEnabled() ? (await loadToon())[timeOfDay === 'afternoon' ? 'afternoon' : 'evening'].refl : null;
  const refl = reflParams && reflParams.on ? reflParams : null;
  station = await createStation({
    scene, renderer, camera, offset: island.stationPlacement.position,
    rotationY: island.stationPlacement.rotationY, sunDir: island.U.uSunDir.value, evening,
    groundMaterial: island.transition.material, refl,
    onProgress: stage,
  });
  worldBase.station = station;
  // Interpolate the existing ramp values for softer boundaries between tones.
  const ramp = station.ctx.mat.gradientMap;
  ramp.magFilter = ramp.minFilter = THREE.LinearFilter;
  ramp.needsUpdate = true;
  worldBase.skyline = createSkyline({ scene, station, island });
  worldBase.skyline.vegetationClear = clearVegetationAreas(island.terrain,
    worldBase.skyline.vegetationClearAreas, station.root.matrixWorld);
  stage('正在安放站后建筑…');
  worldBase.city = await createCity({ scene, station, island, skyline: worldBase.skyline });
  // #254：店铺室内可进入——附加可走区 + 室内碰撞，全部由 shopInteriors 推导
  {
      const { walkExtrasFromRooms, addShopGround, addRoomCollision, clearBoundaryWalls, makeCameraClamp, addLotShopSolid, makeIndoorCamera } = await import('./shop-entry.js');
      const extras = walkExtrasFromRooms(station, worldBase.city, layoutModule);
      station.walkExtra.push(...extras.areas);
      const trim = clearBoundaryWalls(station, extras.areas);
      const ground = addShopGround(station, island, extras.plans);
      const rooms = addRoomCollision(station);
      const lotSolid = addLotShopSolid(station, extras.lotPlans);
      station.clampCamera = makeCameraClamp(station, station.ctx.services.shopInteriors || [], extras.lotPlans);
      station.indoorCamera = makeIndoorCamera(station, station.ctx.services.shopInteriors || [], extras.lotPlans);
      worldBase.shopEntry = {
        walkExtra: extras.areas, skippedExtras: extras.skipped,
        walls: rooms.added.length, skippedRooms: rooms.skipped,
        ground, trim
      };
      if (extras.areas.length) console.log('[world-base] 店铺附加可走区 ' + extras.areas.length + ' 块（其中 lot 店 ' + extras.lotPlans.length + ' 家），台阶 ' + ground.steps + ' 级，墙 ' + (rooms.added.length + lotSolid.walls) + ' 面');
  }
  worldBase.city.vegetationClear = clearVegetationAreas(island.terrain,
    worldBase.city.vegetationClearAreas, station.root.matrixWorld, { flowers: 8, jitter: 2.5 });
  // Art round 23: placeholder massing (far skyline towers + facade infill outside the walkable rects). Built before the
  // weathering, glow and street-zone bake so reflections and outlines see it. ?massing=off installs nothing.
  if (massingEnabled()) {
    stage('正在安放远景楼群…');
    // Art round 24: the real facade modules replace the facade placeholders (wide 10 m deep lots, rows of modules). ?blocks=off keeps r23c.
    const blocksOn = blocksEnabled(), massingParams = blocksOn ? applyBlocksParams(await loadMassing()) : await loadMassing();
    worldBase.massing = await createMassing({ scene, station, island, city: worldBase.city, skyline: worldBase.skyline, params: massingParams, timeOfDay: island.timeOfDay });
    // Art round 24 / 25: real facade rows (?blocks=off keeps r23c) and real towers (?towers=off keeps r24); both share the sign atlas and the
    // camera-distance fog patch.
    const towersOn = towersEnabled();
    if ((blocksOn || towersOn) && massingParams.blocks) {
      stage('正在装立面与高楼模块…');
      const common = { scene, station, island, massing: worldBase.massing, params: massingParams, timeOfDay: island.timeOfDay };
      // Art round 26: the mid-height transition band, the landmark towers and the larger rooftop panels. ?midband=off = the r25 page.
      const midbandOn = midbandEnabled() && !!massingParams.blocks.midband;
      worldBase.massingParams = massingParams;
      worldBase.blockShared = makeShared({ island, params: massingParams, timeOfDay: island.timeOfDay, midband: midbandOn });
      if (blocksOn) worldBase.blocks = await createFacadeBlocks({ ...common, shared: worldBase.blockShared });
      // The ring of mid-rise lots comes from the layout rules; the tower pipeline builds them (and the landmark GLBs) with the r25 towers.
      if (midbandOn) worldBase.midband = layoutMidband({ massing: worldBase.massing, station, params: massingParams });
      if (towersOn) worldBase.towers = await createTowerBlocks({ ...common, shared: worldBase.blockShared, midband: midbandOn ? massingParams.blocks.midband : null, extraSlots: worldBase.midband?.slots });
      if (midbandOn) worldBase.massing.vegetationClearAreas.push(...worldBase.midband.areas);
    }
    worldBase.massing.vegetationClear = clearVegetationAreas(island.terrain,
      worldBase.massing.vegetationClearAreas, station.root.matrixWorld, { flowers: 5, jitter: 2 });
  }
  // X-51 (2026-11-21): island-wide street props (poles, wires, signs, vending machines, post boxes, hydrants, guardrails) and vegetation (trees, bushes,
  // hedges, grass). Rules in src/street-props.js / src/vegetation-scatter.js; they run after every vegetation clear and building slot is known.
  // ?props=off / ?veg=off import nothing, and the page is the one without them.
  {
    const scatterQuery = new URLSearchParams(location.search), propsOn = scatterQuery.get('props') !== 'off', vegOn = scatterQuery.get('veg') !== 'off';
    if (propsOn || vegOn) stage('正在铺放街道道具与植被…');
    if (propsOn) worldBase.streetProps = await (await import('./street-props.js')).createStreetProps({ scene, worldBase, island, station });
    if (vegOn) worldBase.vegetation = await (await import('./vegetation-scatter.js')).createVegetation({ scene, worldBase, island, station });
  }
  // Round 11: the shop-room boxes are installed after the town edge is built (the laundromat registers its room there). No program
  // using the lit chunks has compiled yet: the first render is after init.
  if (shadowTint) {
    // No program using the lit chunk has compiled yet (first render is after init), so the box can be known here.
    const boxes = shopInteriorBoxes(layoutModule, station, shadowTintParams.indoorPad, shadowTintParams.indoorLamp);
    installLitShadowTint(shadowTint, boxes);
    look.setShadowTint(shadowTintUniforms(shadowTint), boxes, shadowTintParams.indoorFade);
    worldBase.shadowTint.indoorBox = boxes;
  }
  // Round 27: outlines + cel bands (?toon=off keeps round 26). Same shop-room boxes as the shadow tint.
  if (toonEnabled()) {
    const toonAll = await loadToon(), toonP = applyForm(toonAll[timeOfDay === 'afternoon' ? 'afternoon' : 'evening']);
    originalFillColor = skyFill.color.clone();
    toonFillColor = new THREE.Color(toonP.skyFill);
    if (worldBase.styleState.toon) skyFill.color.copy(toonFillColor);
    const toonBoxes = worldBase.shadowTint?.indoorBox || shopInteriorBoxes(layoutModule, station, 0.05);
    installLitToon(toonP, toonBoxes);
    installFlatColour(toonP); // round 20: ?form=r19 installs nothing
    worldBase.toonFlat = toonFlatUniforms;
    look.setToonLines(toonLineUniforms(toonP));
    worldBase.toon27 = { params: toonP };
  }
  // Round 12: fixed global grade (dark floor, highlight shoulder, vibrance). ?grade=off restores round 11.
  if (gradeEnabled()) {
    const gradeP = (await loadToon())[timeOfDay === 'afternoon' ? 'afternoon' : 'evening'].grade;
    look.setGrade(gradeP);
    worldBase.grade = { params: gradeP };
  }
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
  walker = station.createWalker(canvas);
  worldBase.walker = walker;
  worldBase.views = [
    { name: 'station-street', fov: 58, position: toWorld([-1.2, 2.4, 36]), target: toWorld([0, 2.0, -25]) },
    { name: 'station-port', fov: 58, position: toWorld([-65, 15, -28]), target: [-45, 21, 1036] },
    { name: 'island-aerial', fov: 58, position: [2100, 2350, 2450], target: [-150, 70, -150] },
    { name: 'shop-interior', fov: 58, position: toWorld([-8.3, 1.9134, 8]), target: toWorld([-12.8, 1.7134, 8]) },
    { name: 'service-corner', fov: 55, position: toWorld(station.texturedProps.stats.view.position), target: toWorld(station.texturedProps.stats.view.target) },
    { name: 'laundry-details', fov: 55, position: toWorld(worldBase.city.stats.texturedProps.view.position), target: toWorld(worldBase.city.stats.texturedProps.view.target) },
    // Ground-level art references for #252. Positions and targets are in the station frame.
    {
      name: 'art-a-street', label: 'A · 01 站前主街', fov: 35.63777782904556, // 35 mm on a 36 mm wide frame at 16:10.
      position: toWorld([-1.2, 2.488, 36]), target: toWorld([0, 2.088, -25]),
    },
    {
      name: 'art-b-konbini', label: 'B · 21 便利店正面', fov: 58,
      position: toWorld([-0.9, 1.8184, 12.8]), target: toWorld([-7.52, 2.0534, 10.6]),
    },
    {
      name: 'art-c-alley', label: 'C · 20 公寓后巷', fov: 45,
      position: toWorld([7.65, 6.384808464050293, -132.68]), target: toWorld([-1.6, 6.55, -129.94]),
    },
    {
      name: 'art-d-laundry', label: 'D · 24 洗衣店', fov: 48,
      position: toWorld([3.5, 4.520055181715234, -116.2]), target: toWorld([2.5, 6.25, -122.6]),
    },
    // Seed 252 samples live at standing height on the quay, a hillside, the railway lane and the northern village street.
    // Keep their world-space poses fixed so an environment change can be compared at the same eye position.
    { name: 'sample-e-harbour', label: 'E · 拉克港码头', fov: 57, position: [-49.3148, 6.0969, 1121.5], target: [-24, 7.2, 1123.5] },
    { name: 'sample-f-hillside', label: 'F · 东部山麓草坡', fov: 57, position: [1040.6682, 61.5086, 591.5865], target: [1062, 102.7783, 490] },
    { name: 'sample-g-rail', label: 'G · 铁路北侧小路', fov: 57, position: [337.8563, 9.6, 844.5], target: [268, 10.55, 857] },
    { name: 'sample-h-north', label: 'H · 北端村道', fov: 57, position: [181.0601, 136.1623, -1212.8685], target: [180, 141.45, -1238] },
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
    if (!/^[1-6]$/.test(event.key)) return;
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
    worldBase.weatheringDecals = addWeatheringDecals({ scene, station, wallMaterials: worldBase.weathering.wallMaterials, vehicleBoxes: worldBase.weathering.vehicleBoxes,
      roots: [station.root, worldBase.city.root, worldBase.skyline.root], gradientMap: station.ctx.mat.gradientMap, explicit: params.decals.explicit,
      baked: await loadBakedDecals(), forcePlan: new URLSearchParams(location.search).get('decals') === 'plan' });
    worldBase.weatheringMs = +(performance.now() - weatheringStart).toFixed(1);
    // ?weathering=off keeps the previous look for before/after captures.
    if (new URLSearchParams(location.search).get('weathering') === 'off') { worldBase.weathering.setEnabled(false); worldBase.weatheringDecals.setEnabled(false); }
  }
  // Art round 9: warm fake light pools under the apartment corridor lamps (evening only; ?doorglow=off skips them).
  if (island.timeOfDay === 'evening' && new URLSearchParams(location.search).get('doorglow') !== 'off') {
    const params = await loadDoorGlow();
    // Apartment corridor lamps (city-apartments.js) plus the upstream generators' registrations (house porch lamps, shop back doors, station lanterns).
    const lamps = resolveDoorLamps(worldBase.city.root, [...worldBase.city.placements.filter(p => p.type === 'apartment').flatMap(p => p.model.lamps ?? []),
      ...(station.ctx.services.doorLamps ?? [])]);
    if (params && lamps.length) worldBase.doorGlow = addDoorGlow({ parent: worldBase.city.root, lamps, params });
  }
  // Art round 10: indoor light spilling onto the paving in front of lit shops (evening only; ?shopspill=off skips it).
  if (island.timeOfDay === 'evening' && new URLSearchParams(location.search).get('shopspill') !== 'off') {
    const params = await loadShopSpill();
    if (params) {
      const rooms = station.ctx.services.shopInteriors ?? [];
      const raw = [...shopFrontsFromRooms(layoutModule, rooms, params)];
      worldBase.city.root.updateWorldMatrix(true, true);
      const t0 = performance.now();
      const fronts = groundSpillFronts(raw, [station.root, worldBase.city.root], params, worldBase.city.root.position);
      worldBase.shopSpill = addShopSpill({ parent: worldBase.city.root, fronts, params });
      worldBase.shopSpill.buildMs = +(performance.now() - t0).toFixed(1);
    }
  }
  // The vehicles' shared glass material is unnamed and its meshes carry no 'glass' name, so the
  // name filter in maskGlassAlpha skipped it and outlines showed through the van windows.
  getVehicleMats(station.ctx).glass.name ||= 'vehicle-glass';
  if (toonEnabled()) maskGlassAlpha(scene);
  // Round 19: printed signs / light boxes take the outline (?form=r18 leaves them masked out as before).
  if (toonEnabled() && signLinesEnabled(worldBase.toon27?.params)) worldBase.toonSigns = markSignMaterials(scene);
  // Round 22: render the zone cubes last, once the whole world (glows, signs, weathering, toon chunks) is final and before the
  // first frame, so every screenshot after worldBase.ready sees the same cubes.
  if (refl) {
    stage('正在烘焙湿路分区反射…');
    const zonesBake = await bakeStreetZones({ world: worldBase, layout: layoutModule, params: refl, uniforms: station.zones.uniforms,
      onProgress: (done, total) => stage(`正在烘焙湿路分区反射 ${done}/${total}…`) });
    station.streetZones = zonesBake;
    worldBase.refl = { params: refl, uniforms: station.zones.uniforms, bakeMs: zonesBake.ms, zones: zonesBake.zones, res: zonesBake.res,
      ...createReflControl(station.zones.uniforms) };
    console.info(`[world-base] street zone cubes: ${zonesBake.zones.length} zones x 6 faces @ ${zonesBake.res}px baked in ${zonesBake.ms} ms`);
  }
  stage('场景已就绪');
  document.querySelector('#loading').hidden = true;
  let last = performance.now(), sampleStart = last, samples = 0;
  let shadowFrames = 0;
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
      // 静态阴影：前 3 帧照常渲染，之后关掉 autoUpdate；shadowEvery=N 则每 N 帧重渲一次
      if (shadowStatic || shadowEvery > 0) {
        shadowFrames++;
        if (shadowFrames === 3) renderer.shadowMap.autoUpdate = false;
        else if (shadowFrames > 3 && shadowEvery > 0 && shadowFrames % shadowEvery === 0) renderer.shadowMap.needsUpdate = true;
      }
      requestAnimationFrame(frame);
    } catch (error) { fail(error); }
  }
  requestAnimationFrame(frame);
}
init().catch(fail);











