import * as THREE from 'three';
import { paintWallTile } from '../upstream/petalwake/src/world/wall-paint.js';

// Round 5 (#254 X-51, C酱): shaded facade bounce. Rear corridors, eaves and north
// faces only get sky ambient.
// Every apartment surface on the island that is out of the sun gets a cool teal-grey
// bounce scaled by its own albedo (sunlit faces are untouched), and the AO map is
// softened. ?shadowtint=off turns the bounce off with the rest of the shade tint.
export const FACADE_BOUNCE = { color: [0.12, 0.16, 0.17], sunLo: 0.04, sunHi: 0.5, aoMapIntensity: 0.4 };
export const PAINTED_STEEL = { metalness: 0.15, normalScale: 0.5 };
const bounceOn = () => typeof location === 'undefined' || new URLSearchParams(location.search).get('shadowtint') !== 'off';
function addFacadeBounce(material, rearCorridor) {
  const b = FACADE_BOUNCE, c = b.color.map(x => x.toFixed(3)).join(', ');
  material.aoMapIntensity = b.aoMapIntensity;
  material.onBeforeCompile = shader => {
    if (rearCorridor) {
      shader.uniforms.uWbRearMin = { value: rearCorridor.min };
      shader.uniforms.uWbRearMax = { value: rearCorridor.max };
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
        #define WB_APARTMENT_REAR_LIGHTING
        uniform vec3 uWbRearMin;
        uniform vec3 uWbRearMax;
        float wbApartmentRear(vec3 p) {
          vec3 edge = min(p - uWbRearMin, uWbRearMax - p);
          return smoothstep(0.0, 0.25, min(edge.x, min(edge.y, edge.z)));
        }`);
    }
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
{ // wbFacadeBounce
  float fbLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  float fbSun = dot( reflectedLight.directDiffuse, vec3( 0.2126, 0.7152, 0.0722 ) ) / max( fbLum, 0.03 );
  vec3 fbFill = vec3( ${c} );
  #ifdef WB_APARTMENT_REAR_LIGHTING
    vec3 fbWorld = cameraPosition + geometryPosition * mat3( viewMatrix );
    fbFill += vec3(0.095, 0.132, 0.158) * wbApartmentRear(fbWorld);
  #endif
  reflectedLight.indirectDiffuse += diffuseColor.rgb * fbFill * ( 1.0 - smoothstep( ${b.sunLo.toFixed(3)}, ${b.sunHi.toFixed(3)}, fbSun ) );
}`);
  };
  material.customProgramCacheKey = () => 'wbFacadeBounce:' + c + (rearCorridor ? ':rear' : '');
}

const SHUTTER = 'worn_shutter';
const WALL_SIZE = 256;
function configureTexture(texture, name, colorSpace, anisotropy) {
  texture.name = name;
  texture.colorSpace = colorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.channel = 0;
  return texture;
}

/** City-local ownership. The caller must dispose this after its GB meshes and
 * must not put these textures in the station's borrowed texture cache. */
export async function createApartmentSurfaces({ renderer, assetBase = '/apartment-assets/', rearCorridor = null }) {
  const loader = new THREE.TextureLoader(), textures = [], materials = {};
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const results = await Promise.allSettled(['diff', 'nor_gl', 'arm'].map(async channel => {
    const url = `${assetBase}${SHUTTER}/textures/${SHUTTER}_${channel}_1k.jpg`;
    const texture = await loader.loadAsync(url);
    textures.push(texture);
    const image = texture.image;
    if ((image.naturalWidth ?? image.width) !== 1024 || (image.naturalHeight ?? image.height) !== 1024) {
      throw new Error(`Apartment texture is not the pinned 1K image: ${url}`);
    }
    configureTexture(texture, `apartment-metal-${channel}`, channel === 'diff' ? THREE.SRGBColorSpace : THREE.NoColorSpace, anisotropy);
    return [channel, texture];
  }));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) {
    for (const texture of textures) texture.dispose();
    throw new AggregateError(failures.map(result => result.reason), 'Apartment PBR image loading failed');
  }
  try {
    for (const key of ['plaster', 'tile']) {
      const map = configureTexture(new THREE.CanvasTexture(paintWallTile(`apartment-${key}`, WALL_SIZE)),
        `apartment-painted-${key}`, THREE.SRGBColorSpace, anisotropy);
      textures.push(map);
      const material = new THREE.MeshStandardMaterial({
        name: `apartment-pbr-${key}`, vertexColors: true, map, roughness: 1,
      });
      // Keep the wall receiver identity for baked posters and edge wear.
      material.userData.wxScale = .26;
      material.userData.apartmentSurface = { asset: map.name, uvChannel: 0 };
      materials[key] = material;
    }
    const maps = Object.fromEntries(results.map(result => result.value));
    materials.metal = new THREE.MeshStandardMaterial({
      name: 'apartment-pbr-metal', vertexColors: true, map: maps.diff, normalMap: maps.nor_gl,
      roughnessMap: maps.arm, roughness: 1, metalnessMap: maps.arm, metalness: 1,
      aoMap: maps.arm, aoMapIntensity: .65,
    });
    materials.metal.userData.apartmentSurface = { asset: SHUTTER, license: 'CC0-1.0',
      normalConvention: 'OpenGL', armChannels: 'R=AO G=roughness B=metalness', uvChannel: 0 };
    materials.roof = materials.metal.clone();
    materials.roof.name = 'apartment-pbr-roof';
    materials.roof.metalness = .25;
    materials.roof.normalScale.set(.35, .35);
    // Round 6 (#254 X-51, C酱): every apartment use of `metal` is painted steel trim
    // (stairs, railings, door frames, sills, drips, gutters, tank legs). The shutter
    // diffuse averages ~0.05 linear and its ARM marks it fully metallic, so with no
    // environment map those parts rendered near-black on the whole island. Painted
    // steel keeps the shutter's normal and roughness detail, takes its colour from the
    // vertex colours, and is dielectric. The roof clone above keeps the shutter look.
    Object.assign(materials.metal, { map: null, metalnessMap: null, metalness: PAINTED_STEEL.metalness });
    materials.metal.normalScale.set(PAINTED_STEEL.normalScale, PAINTED_STEEL.normalScale);
    materials.metal.userData.paintedSteel = true;
    if (bounceOn()) for (const [key, material] of Object.entries(materials)) {
      addFacadeBounce(material, key === 'plaster' || key === 'metal' ? rearCorridor : null);
    }
  } catch (error) {
    for (const material of Object.values(materials)) material.dispose();
    for (const texture of textures) texture.dispose();
    throw error;
  }
  let disposed = false;
  const texturePixels = textures.reduce((sum, texture) => sum + texture.image.width * texture.image.height, 0);
  return { materials, textures,
    stats: { textures: textures.length, materials: Object.keys(materials).length,
      sourcePixels: texturePixels, estimatedRGBA8MipBytes: texturePixels * 4 * 4 / 3,
      anisotropy, extraRenderTargets: 0, perFrameCapturePasses: 0,
      sources: { plaster: 'X-51 authored wall paint', tile: 'X-51 authored wall paint', metal: `https://polyhaven.com/a/${SHUTTER}` },
      ownership: 'City-local materials and textures; roof borrows the shutter maps.' },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const material of Object.values(materials)) material.dispose();
      for (const texture of textures) texture.dispose();
    },
  };
}
