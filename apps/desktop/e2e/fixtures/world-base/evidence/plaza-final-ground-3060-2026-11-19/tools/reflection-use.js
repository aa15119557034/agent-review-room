(function liveScene() {
  const w = window.worldBase, s = w.station, r = w.renderer, ref = s.streetReflections, cube = ref.uniforms.uStreetEnvironment.value;
  const wet = s.wetRoad, roadUniforms = r.properties.get(wet.material)?.uniforms;
  let panes = 0, sharedGlass = 0;
  w.scene.traverse(o => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material ?? [])) if (m.name === 'station-street-window') {
      panes++; if (m.uniforms.uStreetEnvironment === ref.uniforms.uStreetEnvironment) sharedGlass++;
    }
  });
  const gl = r.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  return { timeOfDay:w.island.timeOfDay, profileQuery:location.search, renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,
    canvas:[gl.drawingBufferWidth,gl.drawingBufferHeight], cubeFaces:(cube.images || cube.image).map(x => [x.width,x.height]), flipY:cube.flipY,
    colorSpace:cube.colorSpace, mipmaps:cube.generateMipmaps, reflectionStats:ref.stats, wetStats:wet.stats,
    glazedMeshes:panes, sharedGlass, wetUniformAvailable:!!roadUniforms?.uStreetEnvironment,
    wetCubeShared:roadUniforms?.uStreetEnvironment ? roadUniforms.uStreetEnvironment.value===cube:null,
    nominalSkyEnvironment:w.island.sky.material.uniforms.uEnv.value,
    eveningGlow:w.eveningGlow ?? null, wetInitiallyEnabled:wet.enabled };
}
)()
