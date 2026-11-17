import * as THREE from 'three';
import { GB, Frame } from '../upstream/sakuragaoka/src/world/houses/gb.js';
import { buildFarTown } from '../upstream/sakuragaoka/src/world/houses/far.js';
import { PAL } from '../upstream/sakuragaoka/src/world/houses/lot.js';
import { backgroundContext, visibleBankHeight } from './skyline.js';
import { buildTownApartment, townApartmentBounds, townSortingBins } from './city-apartments.js';

const SITES = [
  // Staggered setbacks and three wall tones (sage / warm tile / pale blue) break the
  // uniform front row; white slabs and parapets stay shared.
  { name: 'town-apartment-3f', x: -17, z: -123.5, width: 11, depth: 9, floors: 3, accent: PAL.siding[1], tone: '#d5e2d8', shop: false },
  { name: 'town-apartment-4f', x: 2, z: -122, width: 12, depth: 9, floors: 4, accent: PAL.tile[0], tone: '#f0dcc8', shop: true },
  { name: 'town-apartment-5f', x: 22, z: -121, width: 12, depth: 10, floors: 5, accent: PAL.plaster[0], tone: '#d2dfe9', shop: false },
];
const LOW_HOUSES = [{ x: -37, z: -126.5, seed: 0 }, { x: -50, z: -127, seed: 1 }];
const FRONT_ROAD = { name: 'town-front-lane', minX: -56, maxX: 37, minZ: -118.5, maxZ: -115.8 };
const EAST_ROAD = { name: 'town-levee-lane', minX: 32, maxX: 37, minZ: -115.8, maxZ: -101 };
const overlaps = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
const laundryAtlasRegions = new WeakMap();

/** Original station kit, local coordinates. Own emitted geometry/material clones;
 * borrow every atlas, gradient and source prototype. Dispose before station. */
export async function createCity({ scene, station, island, skyline }) {
  const source = station.ctx.services.houses.buildContext;
  if (!source) throw new Error('Build station houses before the town edge');
  if (station.root.rotation.y !== 0 || station.root.scale.distanceTo(new THREE.Vector3(1, 1, 1)) > 1e-6) {
    throw new Error('Town sites require the surveyed unscaled, north-facing station');
  }
  const root = new THREE.Group(); root.name = 'station-city-background';
  root.position.copy(station.root.position); root.userData.walkable = false;
  const ownedMaterials = new Set(), geometries = new Set(), clones = new Map();
  const placements = [], vegetationClearAreas = [];
  const stats = { buildings: 0, apartments: 3, lowHouses: 0, modelTriangles: 0, modelPrimitives: 0,
    connections: { roads: [], stairs: [], walkable: false }, trees: [], poles: [] };
  const cacheSize = station.ctx.tex.cache.size, texturePixels = station.ctx.tex.pixels;
  const clone = material => {
    if (!clones.has(material)) {
      const copy = material.clone();
      copy.onBeforeCompile = material.onBeforeCompile;
      copy.customProgramCacheKey = material.customProgramCacheKey;
      copy.clippingPlanes = null; copy.clipIntersection = false; copy.clipShadows = false;
      clones.set(material, copy); ownedMaterials.add(copy);
    }
    return clones.get(material);
  };
  let suppressedPhysicsCalls = 0, disposed = false;
  const physics = Object.fromEntries(['addBox', 'addCylinder', 'addWalkBox', 'addWalkRamp'].map(key => [key, () => { suppressedPhysicsCalls++; }]));
  const ctx = { ...station.ctx, physics, add: object => root.add(object), addStatic: object => root.add(object) };
  const gb = new GB(ctx);
  const M = new Proxy(source.M, { get(target, key) { const value = target[key]; return value?.isMaterial ? clone(value) : value; } });
  const heightAt = (x, z) => {
    const value = island.heightAt(x + root.position.x, z + root.position.z) - root.position.y;
    if (!Number.isFinite(value)) throw new Error('Invalid town terrain height');
    return value;
  };
  const H = backgroundContext(source, ctx, gb, M, heightAt), frame = Frame.at(gb, 0, 0, 0);
  // Keep the store-specific uniforms and GPU lifetime local to this background.
  // The station's material cache is a source of prototypes, not a disposer.
  const houseGlass = M.glass, shopGlass = houseGlass.clone();
  shopGlass.onBeforeCompile = houseGlass.onBeforeCompile;
  shopGlass.customProgramCacheKey = houseGlass.customProgramCacheKey;
  shopGlass.uniforms.uTint.value.set('#e6eef0');
  shopGlass.uniforms.uOpacity.value = 0.08; // thinner veil: the shop interior keeps its colours behind the pane
  shopGlass.uniforms.uStreaks.value = 0;
  ownedMaterials.add(shopGlass);
  H.shopGlass = shopGlass;
  // Neutral light-box face for the laundromat sign (M.lamp reads orange after the grade).
  const signLight = M.lamp.clone();
  signLight.color.set('#f3f1e8').multiplyScalar(1.15);
  ownedMaterials.add(signLight);
  H.signLight = signLight;
  // Apartment walls get their own low-contrast copy of the kit concrete wash: the
  // map is pulled 70% towards its mean, so blotches, dark specks and the tile's
  // centre seams stay as faint grain while the wall keeps its base colour and the
  // lighting keeps the structure. Paving and other concrete keep the shared map.
  const concrete = M.concrete, wallWash = concrete.clone();
  const concreteCompile = concrete.onBeforeCompile, concreteKey = concrete.customProgramCacheKey;
  wallWash.onBeforeCompile = (shader, renderer) => {
    concreteCompile?.call(wallWash, shader, renderer);
    if (!shader.fragmentShader.includes('#include <map_fragment>')) throw new Error('Wall wash: map chunk missing');
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#ifdef USE_MAP
      vec4 sampledDiffuseColor = texture2D( map, vMapUv );
      sampledDiffuseColor.rgb = mix( vec3( 0.93 ), sampledDiffuseColor.rgb, 0.3 );
      diffuseColor *= sampledDiffuseColor;
    #endif`);
  };
  wallWash.customProgramCacheKey = () => (concreteKey ? concreteKey.call(concrete) : '') + '|town-wall-wash';
  ownedMaterials.add(wallWash);
  H.wallWash = wallWash;
  // Town hedges, shrubs and garden trees (#254 C15): the town's own foliage copy is
  // muted towards olive like the town meadow, and its painted leaf clumps get a
  // little more light/shade so the masses stop reading as smooth blobs.
  const foliage = M.foliage, foliageCompile = foliage.onBeforeCompile, foliageKey = foliage.customProgramCacheKey;
  foliage.onBeforeCompile = (shader, renderer) => {
    foliageCompile?.call(foliage, shader, renderer);
    const clumps = 'float tone = (1.0 + 0.1 * hl) * (1.0 - 0.14 * sh);';
    if (!shader.fragmentShader.includes(clumps)) throw new Error('Town foliage: leaf clump shading missing');
    shader.fragmentShader = shader.fragmentShader
      .replace(clumps, 'float tone = (1.0 + 0.16 * hl) * (1.0 - 0.26 * sh);')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float townL = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          diffuseColor.rgb = mix(vec3(townL), diffuseColor.rgb, 0.62) * vec3(1.03, 0.98, 0.86);
        }`);
  };
  foliage.customProgramCacheKey = () => (foliageKey ? foliageKey.call(foliage) : '') + '|town-foliage';
  const dispose = () => {
    if (disposed) return; disposed = true; root.removeFromParent();
    root.traverse(object => { if (object.isMesh) { geometries.add(object.geometry); if (object.isInstancedMesh) object.dispose(); if (object.customDepthMaterial) ownedMaterials.add(object.customDepthMaterial); } });
    for (const geometry of geometries) geometry.dispose();
    for (const material of ownedMaterials) material.dispose();
  };
  const checkLot = (name, lot) => {
    if (lot.maxZ >= station.bounds.z0 || placements.some(p => overlaps(lot, p.footprint)) ||
      skyline.placements.some(p => overlaps(lot, p.footprint.localBounds))) throw new Error('Town lot overlaps an existing building: ' + name);
    const ground = terrainRange(island.terrain, lot, root.position);
    if (ground.relief > 1.6) throw new Error('Town lot exceeds its short-foundation budget: ' + name);
    return ground;
  };
  const foundation = (name, lot, ground) => {
    const top = ground.max + 0.05, bottom = ground.min - 0.05;
    // Warm stone plinth (matches the stair concrete) with a pale coping band, so the
    // exposed side reads as a finished retaining edge rather than a grey slab.
    const cx = (lot.minX + lot.maxX) / 2, cz = (lot.minZ + lot.maxZ) / 2;
    frame.boxB(M.concrete, '#cdc6b6', lot.maxX - lot.minX, top - bottom, lot.maxZ - lot.minZ,
      cx, bottom - root.position.y, cz, { uv: { world: 2 }, shadow: false, skip: 'td' });
    // The walkable top is textured paving in a mid warm grey; only a narrow pale
    // rim marks the edge. (A full pale slab read as one blank sheet in front of
    // the laundromat at eye height.)
    const sx = lot.maxX - lot.minX + 0.08, sz = lot.maxZ - lot.minZ + 0.08, y0 = top - 0.07 - root.position.y, rim = 0.2;
    // Paving sits 5 mm inside the rim so no side face is coplanar with a rim face.
    // The foundation top is inside the paving; its bottom is buried. The paving
    // underside is covered by the foundation and, at the overhang, the rim.
    frame.boxB(M.concrete, '#b8b1a3', sx - 0.01, 0.09, sz - 0.01, cx, y0, cz, { uv: { world: 1.2 }, shadow: false, skip: 'd' });
    for (const side of [-1, 1]) {
      frame.boxB(M.plain, '#e6e1d4', sx, 0.095, rim, cx, y0, cz + side * (sz - rim) / 2, { shadow: false });
      frame.boxB(M.plain, '#e6e1d4', rim, 0.095, sz - 2 * rim, cx + side * (sx - rim) / 2, y0, cz, { shadow: false });
    }
    vegetationClearAreas.push({ name, ...lot });
    return { top, bottom, height: top - bottom };
  };
  station.root.updateWorldMatrix(true, false);
  const matrix = station.root.matrixWorld.clone(), inverse = matrix.clone().invert();
  const visibleGround = visibleBankHeight(station, island, matrix, inverse, heightAt);
  try {
    const shops = station.ctx.services.shopsA.buildContext;
    const signs = getLaundrySigns(shops);
    H.laundrySigns = Object.fromEntries(Object.entries(signs.regions).map(([key, reg]) => [key, { ...reg, m: clone(reg.m) }]));
    stats.laundrySignAtlas = { ...signs.audit, reusedRegions: signs.reused, newTextures: 0,
      text: ['さくら コインランドリー', '洗濯・乾燥', 'セルフサービス'], owner: 'station', pixelsUpdated: !signs.reused };
    for (const site of SITES) {
      const shape = townApartmentBounds(site), b = shape.groundSupportBounds;
      const lot = { minX: site.x + b.minX - 0.15, maxX: site.x + b.maxX + 0.15,
        minZ: site.z + b.minZ - 0.15, maxZ: site.z + b.maxZ + 0.15 };
      const ground = checkLot(site.name, lot), base = foundation(site.name, lot, ground);
      const before = gb.tris;
      const metadata = buildTownApartment(H, Frame.at(gb, site.x, base.top - root.position.y, site.z), site);
      placements.push({ name: site.name, type: 'apartment', center: [site.x, site.z], frontage: [site.x, site.z],
        floors: site.floors, baseY: base.top - root.position.y, floorHeight: metadata.floorHeight, height: metadata.height, footprint: lot, ground, foundation: base, model: metadata, scale: 1,
        staticTriangles: gb.tris - before, worldOrigin: [site.x + root.position.x, base.top, site.z + root.position.z] });
    }
    // Reuse the already-created far facade textures. The upstream generator's
    // z<-82 exclusion requires a temporary positive-z lot; only its raw local
    // geometry is generated there, then the entire house is grounded here.
    for (const key of ['houses_farfacade1', 'houses_farfacade2', 'houses_farfacade3', 'houses_farapt']) {
      if (!station.ctx.tex.cache.has(key)) throw new Error('Missing shared far-town texture: ' + key);
    }
    for (const site of LOW_HOUSES) {
      const group = new THREE.Group(); group.name = 'town-house-' + site.seed;
      const farCtx = { ...ctx, rng: () => station.ctx.rng('city-edge-' + site.seed),
        mat: { ...ctx.mat, toon: (color, options) => clone(ctx.mat.toon(color, options)) },
        addStatic: mesh => group.add(mesh) };
      const far = buildFarTown({ ...H, ctx: farCtx, L: { ...H.L,
        FAR_TOWN: [{ x0: 0, x1: 12, z0: 0, z1: 12 }], heightAt: () => 0 } });
      group.traverse(object => { if (object.isMesh) geometries.add(object.geometry); });
      group.updateWorldMatrix(true, true);
      const bounds = new THREE.Box3().setFromObject(group), size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
      if (far.count !== 1 || size.x > 11 || size.z > 11) throw new Error('Far-house prototype changed: ' + site.seed);
      const lot = { minX: site.x - size.x / 2 - 0.15, maxX: site.x + size.x / 2 + 0.15,
        minZ: site.z - size.z / 2 - 0.15, maxZ: site.z + size.z / 2 + 0.15 };
      const ground = checkLot(group.name, lot), base = foundation(group.name, lot, ground);
      group.position.set(site.x - center.x, base.top - root.position.y - bounds.min.y, site.z - center.z);
      root.add(group);
      placements.push({ name: group.name, type: 'low-house', center: [site.x, site.z], floors: 2,
        footprint: lot, ground, foundation: base, sourceSize: size.toArray(), scale: 1 });
      stats.lowHouses++;
    }
    const connections = addConnections(H, frame, placements, visibleGround, root.position.y);
    stats.connections = connections.report;
    vegetationClearAreas.push(...connections.clearAreas);
    // Two small garden trees at the ends of the row, never a screen of foliage.
    H.lod = 1;
    for (const [x, z] of [[-57.5, -122.5], [30.5, -127]]) {
      const y = heightAt(x, z), start = gb.tris;
      H.P.tree(frame, x, y, z, 1.25, ctx.rng('town-tree-' + x), 'olive');
      stats.trees.push({ x, y, z, triangles: gb.tris - start });
      vegetationClearAreas.push({ name: 'town-tree-' + x, minX: x - 0.9, maxX: x + 0.9, minZ: z - 0.9, maxZ: z + 0.9 });
    }
    addUtilityPoles(H, frame, visibleGround, stats);
    vegetationClearAreas.push(...addLotPlanting(H, frame, placements, heightAt, ctx, stats));
    const shop = placements.find(p => p.name === 'town-apartment-4f');
    const supportY = shop.baseY + .02;
    const crateSource = station.texturedProps;
    const crateGroup = new THREE.Group(); crateGroup.name = 'city-textured-crate';
    crateGroup.position.set(5.55, supportY - crateSource.bounds.min[1], -122.58);
    const crate = crateSource.cratePrototype.clone(true), borrowedAssetTextures = new Set();
    crate.traverse(mesh => {
      if (!mesh.isMesh) return;
      mesh.geometry = mesh.geometry.clone(); geometries.add(mesh.geometry);
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        for (const value of Object.values(material)) if (value?.isTexture) borrowedAssetTextures.add(value);
    });
    crateGroup.add(crate); root.add(crateGroup);
    const signRoot = new THREE.Group(); signRoot.name = 'city-laundry-a-frame'; root.add(signRoot);
    const C = station.ctx.services.shopsA.buildContext;
    const aFrame = C.P.aFrame({ k: station.ctx.kit(signRoot) }, 4.55, supportY, -122.35, .35, H.laundrySigns.aframe, null, { w: .45, h: .68 });
    // This new label plane is not a shared kit primitive. Own it directly rather
    // than cloning and losing the original allocation.
    aFrame.traverse(mesh => { if (mesh.isMesh && mesh.material === H.laundrySigns.aframe.m) geometries.add(mesh.geometry); });
    // Keep the central entrance and the existing crate/pot clear. The rack sits
    // against the right pane, while labelled sorting bins flank the left pane.
    const umbrellas = C.P.umbrellaStand({ k: station.ctx.kit(signRoot) }, 3.65, supportY, -123.0, 0,
      { color: '#87989b', umbrellas: ['#657f99', '#e5dfd2', '#ac7e76'] });
    umbrellas.name = 'town-laundry-umbrella-stand';
    // Kit primitives are station cache entries. Never release their originals
    // from the city; preserve shared textures but own these geometry copies.
    const propGeometry = new Map();
    signRoot.traverse(mesh => {
      if (!mesh.isMesh) return;
      if (!geometries.has(mesh.geometry)) {
        if (!propGeometry.has(mesh.geometry)) propGeometry.set(mesh.geometry, mesh.geometry.clone());
        mesh.geometry = propGeometry.get(mesh.geometry); geometries.add(mesh.geometry);
      }
      const ownMaterial = material => ownedMaterials.has(material) ? material : clone(material);
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(ownMaterial) : ownMaterial(mesh.material);
    });
    const potStart = gb.tris;
    H.P.pot(frame, 6.25, supportY, -122.7, ctx.rng('town-laundry-pot'), .8, 'terra');
    const potTriangles = gb.tris - potStart;
    const densityStart = gb.tris;
    townSortingBins(H, frame, -.4, supportY, -122.93, 2);
    // Rear ground-floor housekeeping stays beside the rightmost door; it does
    // not occupy the central steel-stair landing or cross a door opening.
    const rear = Frame.at(gb, shop.center[0], shop.baseY + .14, -131, Math.PI);
    H.P.broom(rear, -5.2, 0, .14);
    H.P.dustpan(rear, -4.85, 0, .26);
    H.P.bucket(rear, -5.15, 0, .74, ctx.rng('town-rear-bucket'));
    H.P.elecMeter(rear, -3.15, 1.3);
    // Two labelled parcels on the first-floor corridor borrow the house atlas.
    // The lower box supports the smaller one, with room beside the door.
    const parcelUV = { uv: { rect: H.A.rects.cardboard, white: H.A.white } };
    rear.boxB(M.atlas, '#ffffff', .46, .27, .36, -5.15, 2.85, .37, parcelUV);
    rear.boxB(M.atlas, '#eee2cf', .34, .18, .30, -5.12, 3.12, .37, parcelUV);
    const density = {
      gbTriangles: gb.tris - densityStart, umbrellaTriangles: 0,
      laundry: { umbrellaStand: [3.65, supportY, -123], sortingBins: [-.4, supportY, -122.93], binCount: 2 },
      rear: { origin: rear.origin.toArray(), rotationY: Math.PI, broom: [-5.2, 0, .14],
        dustpan: [-4.85, 0, .26], bucket: [-5.15, 0, .74], meter: [-3.15, 1.3],
        parcels: [{ center: [-5.15, 2.85, .37], size: [.46, .27, .36] }, { center: [-5.12, 3.12, .37], size: [.34, .18, .30] }] },
      source: 'Pinned Sakuragaoka MIT builders and existing house atlas; no new textures', walkable: false,
    };
    umbrellas.traverse(mesh => { if (mesh.isMesh) density.umbrellaTriangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3; });
    density.totalTriangles = density.gbTriangles + density.umbrellaTriangles;
    stats.densityProps = density;
    stats.texturedProps = { crate: { position: crateGroup.position.toArray(), triangles: crateSource.stats.crateTriangles },
      sign: { position: [4.55, supportY, -122.35], rotationY: .35, size: [.45, .68], blank: false, text: 'さくら コインランドリー / 洗濯・乾燥 / セルフサービス' },
      pot: { position: [6.25, supportY, -122.7], triangles: potTriangles },
      view: { position: [8, supportY + 1.6, -122.1], target: [5.15, supportY + .36, -122.7] },
      walkable: false, borrowedAssetTextures: borrowedAssetTextures.size };
    const facades = placements.filter(p => p.type === 'apartment').map(p => ({ name: p.name,
      origin: [p.center[0], p.baseY, p.center[1]], ...p.model.facade }));
    stats.facadeLife = { buildings: facades, signTriangles: 20,
      signs: { horizontal: { position: [2.45, shop.baseY + 2.43, -122.1745], size: [4.56, .22] },
        glass: [-1.8, 1.8].map(x => ({ position: [2 + x, shop.baseY + 1.18, -123.216], size: [.82, .30] })),
        aFrame: stats.texturedProps.sign },
      totalTriangles: facades.reduce((n, f) => n + f.totalTriangles, 20), walkable: false };
    if (stats.facadeLife.totalTriangles > 900) throw new Error('Facade pass exceeds its 900-triangle allocation');
    gb.flush(root, 'town-edge-kit');
    const laundry = H.laundry.build();
    if (laundry) { ownedMaterials.add(laundry.material); ownedMaterials.add(laundry.customDepthMaterial); }
    const borrowedTextures = new Set();
    root.traverse(object => {
      if (!object.isMesh) return;
      geometries.add(object.geometry); object.userData.walkable = false;
      // Shadow flags stay as the builders set them (gb bins, far houses, laundry):
      // town meshes cast/receive by default, while lamps, the light-box sign and
      // shop glass are built with shadow:false and must not cast.
      const instances = object.isInstancedMesh ? object.count : 1;
      stats.modelTriangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3 * instances;
      stats.modelPrimitives += object.geometry.groups.length || 1;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const value of Object.values(material)) if (value?.isTexture) borrowedTextures.add(value);
      }
    });
    if (stats.modelTriangles >= 30000) throw new Error('Town exceeds the 30000-triangle budget: ' + stats.modelTriangles);
    if (station.ctx.tex.cache.size !== cacheSize || station.ctx.tex.pixels !== texturePixels) throw new Error('Town unexpectedly generated textures');
    stats.buildings = placements.length; stats.totalTriangles = stats.modelTriangles;
    stats.materials = ownedMaterials.size; stats.geometries = geometries.size; stats.borrowedTextures = borrowedTextures.size;
    stats.uniqueTextures = borrowedTextures.size; stats.ownedTextures = 0; stats.newTexturePixels = 0; stats.ownedTextureRGBA8WithMipsEstimateBytes = 0; stats.textureCacheEntriesAdded = 0;
    stats.laundryItems = H.laundry.count; stats.suppressedPhysicsCalls = suppressedPhysicsCalls;
    stats.ownership = 'Own emitted geometry, far instances and material clones; borrow all station atlases, far facade textures and gradient maps. Dispose before station.';
    stats.limitation = 'Background only: no new physics or navigable interiors. Foundations and stairs are CPU checked; camera composition and visible CDLOD contacts need GPU acceptance.';
    scene.add(root); root.updateWorldMatrix(true, true);
    return { root, placements, vegetationClearAreas, stats, dispose };
  } catch (error) { dispose(); throw error; }
}

function getLaundrySigns(C) {
  const atlas = C.A.lit, cached = laundryAtlasRegions.get(atlas);
  if (cached) return { ...cached, reused: true };
  const requests = [['name', 512, 96], ['function', 256, 96], ['aframe', 192, 192]];
  const page = atlas.pages.at(-1), before = { pages: atlas.pages.length, x: page.x, y: page.y, rowH: page.rowH };
  let { x, y, rowH } = page;
  // Same pad/row rule as the pinned Atlas.region. Reject before painting if any
  // requested label would allocate another page; the station owns this texture.
  for (const [, w, h] of requests) {
    if (x + w + 8 > atlas.size) { x = 0; y += rowH; rowH = 0; }
    if (y + h + 8 > atlas.size) throw new Error('Existing shop atlas has no room for the laundry labels');
    x += w + 8; rowH = Math.max(rowH, h + 8);
  }
  const regions = {};
  for (const [key, w, h] of requests) regions[key] = atlas.region(w, h, (g, W, H) => {
    g.fillStyle = '#f0eee3'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#456969'; g.fillRect(0, 0, W, 5); g.fillRect(0, H - 5, W, 5);
    const text = (s, yy, size) => C.U.text(g, s, W / 2, yy, size, C.F.sans, '#344e50', { maxW: W - 20, weight: 700 });
    if (key === 'name') text('さくら コインランドリー', H / 2, 42);
    else if (key === 'function') { text('洗濯・乾燥', 30, 30); text('セルフサービス', 69, 26); }
    else { text('さくら', 33, 28); text('コインランドリー', 72, 25); text('洗濯・乾燥', 121, 27); text('セルフサービス', 157, 21); }
  }, { bg: '#f0eee3' });
  page.t.needsUpdate = true;
  const result = { regions, audit: { page: before.pages - 1, before,
    after: { pages: atlas.pages.length, x: page.x, y: page.y, rowH: page.rowH },
    regions: requests.map(([key, w, h]) => ({ key, w, h, uv: [regions[key].u0, regions[key].v0, regions[key].u1, regions[key].v1] })) } };
  laundryAtlasRegions.set(atlas, result);
  return { ...result, reused: false };
}

function addConnections(H, frame, placements, ground, worldY) {
  const clearAreas = [], report = { roads: [], stairs: [], walkable: false };
  for (const road of [FRONT_ROAD, EAST_ROAD]) {
    const nx = Math.ceil(road.maxX - road.minX), nz = Math.ceil(road.maxZ - road.minZ);
    const P = [], N = [], U = [], I = [];
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = road.minX + (road.maxX - road.minX) * i / nx, z = road.minZ + (road.maxZ - road.minZ) * j / nz;
      P.push(x, ground(x, z) + 0.06, z); N.push(0, 1, 0); U.push(x / 4, -z / 4);
      if (i < nx && j < nz) { const a = j * (nx + 1) + i, c = a + nx + 1; I.push(a, c, a + 1, a + 1, c, c + 1); }
    }
    H.gb.mesh(H.M.asphalt, '#a6a5a1', P, N, U, I, frame.M(0, 0, 0), { shadow: false });
    clearAreas.push(road); report.roads.push({ ...road, triangles: I.length / 3, groundOffset: 0.06 });
  }
  const stairs = (name, x, width, highZ, lowZ, top) => {
    const low = Math.max(...[-0.5, 0, 0.5].map(side => ground(x + side * width, lowZ))) + 0.065;
    const drop = top - low, count = Math.ceil(drop / 0.18), run = Math.abs(lowZ - highZ);
    if (!(drop > 0 && run / count >= 0.25)) throw new Error('Town entrance cannot fit stairs: ' + name);
    const uphillFace = highZ < lowZ ? 'b' : 'f';
    let minClearance = Infinity;
    for (let k = 0; k < count; k++) {
      const za = highZ + (lowZ - highZ) * k / count, zb = highZ + (lowZ - highZ) * (k + 1) / count, level = top - drop * k / count;
      const nx = Math.ceil(width / 0.1), nz = Math.ceil(Math.abs(zb - za) / 0.1);
      let min = Infinity, max = -Infinity;
      for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
        const y = ground(x - width / 2 + width * i / nx, za + (zb - za) * j / nz); min = Math.min(min, y); max = Math.max(max, y);
      }
      if (level < max + 0.005) throw new Error('Town stair intersects visible terrain: ' + name);
      minClearance = Math.min(minClearance, level - max);
      const bottom = min - 0.05;
      // Bottoms are buried. Each later uphill face is covered by the preceding
      // taller step above ground; keep the first face and every downhill riser.
      frame.boxB(H.M.concrete, '#c5c1b7', width, level - bottom, Math.abs(zb - za), x, bottom, (za + zb) / 2,
        { uv: { world: 2 }, shadow: false, skip: 'd' + (k ? uphillFace : '') });
    }
    clearAreas.push({ name, minX: x - width / 2, maxX: x + width / 2, minZ: Math.min(highZ, lowZ), maxZ: Math.max(highZ, lowZ) });
    report.stairs.push({ name, x, width, highZ, lowZ, steps: count, rise: drop / count, tread: run / count, top, bottom: low, minClearance });
  };
  for (const placement of placements) {
    const doorway = placement.type === 'apartment' ? placement.model.entrances[0] : { x: 0, y: 0 };
    stairs(placement.name + '-entry', placement.center[0] + doorway.x, 2.2, placement.type === 'apartment' ? placement.frontage[1] : placement.footprint.maxZ,
      FRONT_ROAD.minZ - 0.01, placement.foundation.top - worldY + doorway.y);
  }
  const r5 = H.L.ROADS.R5;
  stairs('town-levee-stairs', 34.5, 5, r5.z - r5.halfW - 0.03, EAST_ROAD.maxZ, r5.y + 0.03);
  return { clearAreas, report };
}

// Low hedges between each lot and the lane (gap at the entry stairs) and a
// couple of shrubs at the rear corners soften the plinth / meadow boundary.
function addLotPlanting(H, frame, placements, ground, ctx, stats) {
  stats.planting = [];
  const clearAreas = [];
  for (const p of placements) {
    const r = ctx.rng('town-planting-' + p.name), lot = p.footprint, start = H.gb.tris;
    const z = Math.min(lot.maxZ + 0.55, FRONT_ROAD.minZ - 0.45), gap = 1.5, door = p.center[0];
    for (const [x0, x1] of [[lot.minX + 0.2, door - gap], [door + gap, lot.maxX - 0.2]]) {
      if (x1 - x0 > 1) {
        H.P.hedge(frame, x0, x1, z, 0.75, 0.55, r, 'dark', ground);
        clearAreas.push({ name: p.name + '-hedge-' + x0, minX: x0 - 0.2, maxX: x1 + 0.2, minZ: z - 0.5, maxZ: z + 0.5 });
      }
    }
    for (const x of [lot.minX + 0.3, lot.maxX - 0.3]) {
      const zb = lot.minZ - 0.6;
      H.P.bush(frame, x, ground(x, zb), zb, 0.75, r, { flowers: 'azalea' });
      // These 0.75m shrubs have procedural lobes reaching about 1.2m out.
      // Clear their cover, without enlarging the foundation or moving terrain.
      clearAreas.push({ name: p.name + '-bush-' + x, minX: x - 1.3, maxX: x + 1.3, minZ: zb - 1.3, maxZ: zb + 1.3 });
    }
    stats.planting.push({ name: p.name, hedgeZ: z, triangles: H.gb.tris - start });
  }
  return clearAreas;
}

function addUtilityPoles(H, frame, ground, stats) {
  const positions = [[-28, -116.2], [30.4, -116.2]];
  const tops = [];
  for (const [x, z] of positions) {
    const y = ground(x, z), h = 7.4;
    frame.cyl(H.M.concrete, '#9eaaa8', 0.13, h, x, y + h / 2, z, { rTop: 0.08, seg: 8, shadow: false });
    frame.box(H.M.plain, '#677573', 2.0, 0.12, 0.12, x, y + h - 0.45, z, { shadow: false });
    for (const dx of [-0.7, 0.7]) frame.cyl(H.M.plain, '#cbc9be', 0.06, 0.17, x + dx, y + h - 0.3, z, { seg: 6, shadow: false });
    stats.poles.push({ x, z, height: h }); tops.push([x, y + h - 0.2, z]);
  }
  for (const dx of [-0.7, 0.7]) for (let i = 0; i < 16; i++) {
    const point = t => [THREE.MathUtils.lerp(tops[0][0], tops[1][0], t) + dx,
      THREE.MathUtils.lerp(tops[0][1], tops[1][1], t) - 4 * 0.6 * t * (1 - t), tops[0][2]];
    frame.beam(H.M.plain, '#545d60', point(i / 16), point((i + 1) / 16), 0.025, 0.025, { shadow: false });
  }
}

// Bilinear heightAt reaches its extrema at grid/boundary intersections. Include
// those exactly rather than guessing from a few footprint corners.
function terrainRange(terrain, lot, offset) {
  const half = terrain.meta.world / 2, cell = terrain.cell;
  const axis = (min, max) => {
    const points = [min, max];
    for (let i = Math.ceil((min + half) / cell - 0.5); ; i++) {
      const value = (i + 0.5) * cell - half;
      if (value >= max) break;
      if (value > min) points.push(value);
    }
    return points;
  };
  const xs = axis(lot.minX + offset.x, lot.maxX + offset.x);
  const zs = axis(lot.minZ + offset.z, lot.maxZ + offset.z);
  let min = Infinity, max = -Infinity;
  for (const x of xs) for (const z of zs) {
    const height = terrain.heightAt(x, z);
    if (!Number.isFinite(height)) throw new Error('Invalid city foundation terrain');
    min = Math.min(min, height); max = Math.max(max, height);
  }
  return { min, max, relief: max - min, samples: xs.length * zs.length, method: 'All bilinear grid and footprint boundary intersections' };
}
