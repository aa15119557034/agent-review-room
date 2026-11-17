import * as THREE from 'three';

// Source bytes and CC0 authors are pinned in apartment-assets.json. These are
// Poly Haven diffuse / OpenGL normal / packed ARM images, not generated noise.
const SETS = {
  plaster: ['white_plaster_02', 'white_plaster_02'],
  tile: ['rectangular_facade_tiles', 'rectangular_facade_tiles'],
  metal: ['worn_shutter/textures', 'worn_shutter'],
};

/** City-local ownership. The caller must dispose this after its GB meshes and
 * must not put these textures in the station's borrowed texture cache. */
export async function createApartmentSurfaces({ renderer, assetBase = '/apartment-assets/' }) {
  const loader = new THREE.TextureLoader(), textures = [], materials = {};
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const pending = Object.entries(SETS).flatMap(([key, [dir, stem]]) =>
    ['diff', 'nor_gl', 'arm'].map(channel => ({ key, channel,
      url: `${assetBase}${dir}/${stem}_${channel}_1k.jpg` })));
  const results = await Promise.allSettled(pending.map(async record => {
    const texture = await loader.loadAsync(record.url);
    textures.push(texture);
    const image = texture.image;
    if ((image.naturalWidth ?? image.width) !== 1024 || (image.naturalHeight ?? image.height) !== 1024) {
      throw new Error(`Apartment texture is not the pinned 1K image: ${record.url}`);
    }
    texture.name = `apartment-${record.key}-${record.channel}`;
    texture.colorSpace = record.channel === 'diff' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = anisotropy;
    texture.channel = 0;
    return { ...record, texture };
  }));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) {
    for (const texture of textures) texture.dispose();
    throw new AggregateError(failures.map(result => result.reason), 'Apartment PBR image loading failed');
  }
  try {
    for (const key of Object.keys(SETS)) {
      const maps = Object.fromEntries(results.map(result => result.value).filter(record => record.key === key)
        .map(record => [record.channel, record.texture]));
      const material = new THREE.MeshStandardMaterial({
        name: `apartment-pbr-${key}`, vertexColors: true, color: '#ffffff',
        map: maps.diff, normalMap: maps.nor_gl,
        normalScale: new THREE.Vector2(key === 'plaster' ? .45 : .7, key === 'plaster' ? .45 : .7),
        roughnessMap: maps.arm, roughness: 1,
        metalnessMap: maps.arm, metalness: key === 'metal' ? 1 : 0,
        aoMap: maps.arm, aoMapIntensity: .65,
      });
      material.userData.apartmentSurface = { asset: SETS[key][1], license: 'CC0-1.0',
        normalConvention: 'OpenGL', armChannels: 'R=AO G=roughness B=metalness', uvChannel: 0 };
      materials[key] = material;
    }
    materials.roof = materials.metal.clone();
    materials.roof.name = 'apartment-pbr-roof';
    materials.roof.metalness = .25;
    materials.roof.normalScale.set(.35, .35);
  } catch (error) {
    for (const material of Object.values(materials)) material.dispose();
    for (const texture of textures) texture.dispose();
    throw error;
  }
  let disposed = false;
  return { materials, textures,
    stats: { textures: textures.length, materials: Object.keys(materials).length,
      sourcePixels: 9 * 1024 * 1024, estimatedRGBA8MipBytes: 9 * 1024 * 1024 * 4 * 4 / 3,
      anisotropy, extraRenderTargets: 0, perFrameCapturePasses: 0,
      sources: Object.fromEntries(Object.entries(SETS).map(([key, [, id]]) => [key, `https://polyhaven.com/a/${id}`])),
      ownership: 'City-local materials and all nine textures; roof borrows metal maps within this same owner. No station texture disposal.',
      limits: 'RGBA8 mip memory is an estimate, not measured GPU allocation; final lighting, normal detail and frame time need the integrated GPU run.' },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const material of Object.values(materials)) material.dispose();
      for (const texture of textures) texture.dispose();
    },
  };
}
