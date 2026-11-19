import * as THREE from 'three';
import { World } from '../upstream/petalwake/src/core/ctx.js';

// Compare grounded feet with the actual alternating triangles of the player's
// highest-detail CDLOD mesh. The field is sampled at texel centres.
function surfaceY(terrain, x, z) {
  const fx = (x + World.half)/terrain.cell - 0.5, fz = (z + World.half)/terrain.cell - 0.5;
  const ix = Math.floor(fx), iz = Math.floor(fz), u = fx-ix, v = fz-iz;
  const i = iz*terrain.N+ix, h = terrain.h;
  const a=h[i], b=h[i+1], c=h[i+terrain.N], d=h[i+terrain.N+1];
  if ((ix+iz)&1) return u+v<=1 ? a+(b-a)*u+(c-a)*v : d+(c-d)*(1-u)+(b-d)*(1-v);
  return u>=v ? a+(b-a)*(u-v)+(d-a)*v : a+(c-a)*(v-u)+(d-a)*u;
}

// Drive the production controller via its ordinary pointer and keyboard listeners.
// The timed capture uses native W events; the contact check advances fixed substeps.
export function beginTrailWalk(w) {
  const { station, walker, island } = w, route = island.coastRoute;
  w.startWalking();
  walker.setView('first');
  const start = new THREE.Vector3(route.startX, 0, route.startZ - 5);
  start.y = station.groundHeight(start);
  walker.setPose(start, 180, -6);
  document.querySelector('#world').dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 0, clientY: 0 }));
  let cursor = 0;
  return {
    start,
    steer(direction) {
      const feet = walker.worldPosition, ahead = feet.z + 2 * direction;
      const heading = Math.atan2(feet.x - route.centerX(ahead-route.startZ), feet.z - ahead);
      const turn = Math.atan2(Math.sin(heading-walker.yaw), Math.cos(heading-walker.yaw));
      cursor -= turn / 0.0022;
      window.dispatchEvent(new PointerEvent('pointermove', {clientX: Math.round(cursor), clientY: 0}));
    },
    release() { window.dispatchEvent(new PointerEvent('pointerup')); },
  };
}

export function validateEnvironment(w) {
  const { island, station, walker }=w, route=island.coastRoute, t=island.terrain;
  const results=[];
  const check=(name, ok, details)=>results.push({name, ok, details});
  const water=island.water.material.uniforms, river=island.river.material.uniforms, sky=island.sky.material.uniforms;
  check('sky, sea and river share both moving cloud decks', ['uCloudTex','uCloudFlow','uNoiseTex'].every(k=>sky[k] && sky[k]===river[k] && sky[k]===water[k]), {});
  check('CPU and GPU share the edited height field and sea level', t.h===island.U.uHeightTex.value.image.data && t.material.uniforms.uSeaSetup===water.uSeaSetup,
    {worldMetres:World.size, samples:t.N*t.N, ...island.stats.relief});
  const feet = walker.worldPosition;
  const drive = beginTrailWalk(w);
  const { start } = drive;
  const startZ = start.z;
  const key = (type,code) => window.dispatchEvent(new KeyboardEvent(type,{code}));
  let maxError=0, maxEyeError=0, routeSamples=0, closestWet=Infinity;
  const checkpoints=[];
  const ray=new THREE.Raycaster(undefined,new THREE.Vector3(0,-1,0));
  key('keydown','KeyW');
  try {
    for (const direction of [1,-1]) {
      for (let frame=0;frame<1050;frame++) {
        drive.steer(direction);
        walker.update(0.05);
        const dz=feet.z-route.startZ;
        if (dz>=0) {
          let y=surfaceY(t,feet.x,feet.z);
          if (dz<2) {
            ray.ray.origin.set(feet.x,feet.y+5,feet.z);
            const hit=ray.intersectObject(island.transition)[0];
            if (!hit) throw new Error('Ground join missing under feet');
            y=hit.point.y;
          }
          maxError=Math.max(maxError,Math.abs(feet.y-y));
          maxEyeError=Math.max(maxEyeError,Math.abs(w.camera.position.y-feet.y-1.52));
          closestWet=Math.min(closestWet,feet.y);
          routeSamples++;
        }
        if (frame%130===0) checkpoints.push({direction,frame,feet:feet.toArray()});
        if (direction<0 && feet.z<startZ) break;
      }
      if (direction===1) check('walked continuously through road exit to the swash limit',feet.z>route.startZ+90 && closestWet>=-0.081 && closestWet<0.1,
        {start:start.toArray(), shore:feet.toArray(), closestWet});
    }
    check('returned to station through the same seam', feet.z<=startZ, {end:feet.toArray()});
    check('feet and first-person eye agree with terrain triangles and seam',routeSamples>1000 && maxError<0.08 && maxEyeError<1e-5,
      {routeSamples,maxError,maxEyeError,checkpoints});
  } finally {
    key('keyup','KeyW');
    drive.release();
    w.setView('station-street');
  }
  return {ok:results.every(r=>r.ok), results};
}
