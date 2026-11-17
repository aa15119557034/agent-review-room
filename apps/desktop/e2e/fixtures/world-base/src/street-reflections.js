import * as THREE from 'three';

// A shop window a few metres from the camera needs the building opposite it
// to stay put as the viewer walks. Intersect the ray with the street envelope
// before looking it up in the cube photographed from the middle of the block.
export const STREET_REFLECTION_GLSL = /* glsl */`
  uniform samplerCube uStreetEnvironment;
  uniform mat4 uStreetWorldToLocal;
  uniform vec3 uStreetOrigin, uStreetMin, uStreetMax;
  vec3 streetReflection(vec3 worldPosition, vec3 worldRay, float lod) {
    vec3 p = (uStreetWorldToLocal * vec4(worldPosition, 1.0)).xyz;
    mat3 basis = mat3(uStreetWorldToLocal);
    vec3 r = basis * worldRay;
    vec3 side = step(vec3(0.0), r);
    vec3 safeRay = mix(vec3(-1.0), vec3(1.0), side) * max(abs(r), vec3(0.0001));
    vec3 toWall = (mix(uStreetMin, uStreetMax, side) - p) / safeRay;
    float t = max(0.0, min(toWall.x, min(toWall.y, toWall.z)));
    vec3 fromProbe = normalize(p + r * t - uStreetOrigin);
    // The sky is effectively at infinity above the eaves.
    vec3 dir = mix(fromProbe, r, smoothstep(0.40, 0.88, r.y)) * basis;
    return textureLod(uStreetEnvironment, dir, lod).rgb;
  }`;

const FRONT_DEPTH = { W1: -2.6, W2: -2.5, E1: -3.8, E2: -1.2, E3: -2.0 };

function glassMaterial(original, uniforms) {
  const glass = original.clone();
  glass.name = 'station-street-window';
  Object.assign(glass.uniforms, uniforms);
  glass.fragmentShader = /* glsl */`
    #include <common>
    #include <fog_pars_fragment>
    uniform vec3 uTint;
    uniform float uOpacity;
    varying vec3 vW, vN;
    ${STREET_REFLECTION_GLSL}
    void main() {
      vec3 V = normalize(cameraPosition - vW);
      vec3 N = normalize(vN);
      float grazing = pow(1.0 - abs(dot(V, N)), 3.0);
      vec3 street = streetReflection(vW, reflect(-V, N), mix(1.2, 0.65, grazing));
      float facingStreet = step(0.0, dot(V, N));
      float opacity = (0.08 + 0.32 * uOpacity + 0.48 * grazing) * mix(0.53, 1.0, facingStreet);
      gl_FragColor = vec4(mix(uTint * 0.32, street, 0.90), opacity);
      #include <fog_fragment>
    }`;
  return glass;
}

export function createStreetReflections(root, layout) {
  const z = 18, x = layout.streetCenterX(z);
  const origin = new THREE.Vector3(x, layout.heightAt(x, z) + 1.9, z);
  const uniforms = {
    uStreetEnvironment: { value: null },
    uStreetWorldToLocal: { value: new THREE.Matrix4() },
    uStreetOrigin: { value: origin },
    uStreetMin: { value: new THREE.Vector3(x - 9.7, -1, -7) },
    uStreetMax: { value: new THREE.Vector3(x + 9.7, 11, 43) },
  };
  const fronts = Object.entries(FRONT_DEPTH).map(([id, depth]) => {
    const f = layout.lotFrame(layout.lotById(id));
    return { id, depth, width: f.w, toLot: new THREE.Matrix4().makeRotationY(f.rotY).setPosition(f.x, f.y, f.z).invert() };
  });
  const panes = {}, clones = new Map(), centre = new THREE.Vector3(), box = new THREE.Box3(), transform = new THREE.Matrix4();
  root.updateWorldMatrix(true, true);
  root.traverse(mesh => {
    const m = mesh.material;
    if (!mesh.isMesh || mesh.isInstancedMesh || m?.uniforms?.uStreaks?.value !== 1 || m.uniforms.uFrost.value) return;
    const geometry = mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    // Pinned lots also contain cake cases and upstairs/back windows using the
    // same material. Select first-storey frontage in the shop's own frame.
    for (const f of fronts) {
      box.copy(geometry.boundingBox).applyMatrix4(transform.multiplyMatrices(f.toLot, mesh.matrixWorld));
      box.getCenter(centre);
      if (centre.y < 0.6 || centre.y > 3.4 || Math.abs(centre.x) > f.width * 0.5 ||
          Math.abs(centre.z - f.depth) > 0.38 || box.max.z - box.min.z > 0.12 ||
          box.max.x - box.min.x < 0.35 || box.max.y - box.min.y < 0.18) continue;
      if (!clones.has(m)) clones.set(m, glassMaterial(m, uniforms));
      mesh.material = clones.get(m);
      panes[f.id] = (panes[f.id] || 0) + 1;
      break;
    }
  });
  for (const { id } of fronts) if (!panes[id]) throw new Error('Missing street-facing windows on lot ' + id);
  const resolution = 256;
  const stats = { resolution, panes, captures: 0, facesAtLoad: 0, passesPerFrame: 0, captureSubmitMs: 0 };
  let target;
  return {
    uniforms, stats,
    capture(renderer, scene) {
      if (target) return;
      target = new THREE.WebGLCubeRenderTarget(resolution, {
        type: THREE.HalfFloatType, generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      });
      target.texture.name = 'station-street-reflection';
      const camera = new THREE.CubeCamera(0.18, 84, target);
      camera.layers.enableAll();
      camera.position.copy(origin).applyMatrix4(root.matrixWorld);
      uniforms.uStreetWorldToLocal.value.copy(root.matrixWorld).invert();
      const shadows = renderer.shadowMap;
      const auto = shadows.autoUpdate, needed = shadows.needsUpdate;
      const previousTarget = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
      const xr = renderer.xr.enabled;
      const start = performance.now();
      // Draw through the front glass into the shops; the new target is first
      // bound as a sampler after all six faces and their mipmaps are finished.
      for (const glass of clones.values()) glass.visible = false;
      try {
        shadows.autoUpdate = false;
        shadows.needsUpdate = true;
        camera.update(renderer, scene);
        uniforms.uStreetEnvironment.value = target.texture;
        stats.captures++;
        stats.facesAtLoad += 6;
        stats.captureSubmitMs = Math.round(performance.now() - start);
      } catch (error) {
        renderer.setRenderTarget(previousTarget, face, mip);
        renderer.xr.enabled = xr;
        target.dispose();
        target = null;
        throw error;
      } finally {
        shadows.autoUpdate = auto;
        shadows.needsUpdate = needed;
        for (const glass of clones.values()) glass.visible = true;
      }
    },
    dispose() {
      uniforms.uStreetEnvironment.value = null;
      target?.dispose();
      target = null;
    },
  };
}
