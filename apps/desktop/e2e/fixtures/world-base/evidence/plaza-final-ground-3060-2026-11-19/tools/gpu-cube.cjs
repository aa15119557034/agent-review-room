async function observeUploadedCube() {
  const w=window.worldBase, r=w.renderer, gl=r.getContext(), s=w.station, ref=s.streetReflections;
  const cube=ref.uniforms.uStreetEnvironment.value, tex=r.properties.get(cube).__webglTexture;
  if (!tex || !gl.isTexture(tex)) throw Error('The normal draw has not uploaded its cube');
  const old={read:gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), buffer:gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
    align:gl.getParameter(gl.PACK_ALIGNMENT),row:gl.getParameter(gl.PACK_ROW_LENGTH),rows:gl.getParameter(gl.PACK_SKIP_ROWS),
    pixels:gl.getParameter(gl.PACK_SKIP_PIXELS),readBuffer:gl.getParameter(gl.READ_BUFFER)};
  const fbo=gl.createFramebuffer(), faces=[];
  const hash=async raw=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',raw))]
    .map(v=>v.toString(16).padStart(2,'0')).join('');
  const before=gl.getError();
  try {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,fbo);gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);
    gl.pixelStorei(gl.PACK_ALIGNMENT,4);gl.pixelStorei(gl.PACK_ROW_LENGTH,0);
    gl.pixelStorei(gl.PACK_SKIP_ROWS,0);gl.pixelStorei(gl.PACK_SKIP_PIXELS,0);
    const names=['px','nx','py','ny','pz','nz'];
    for(const [i,img] of cube.image.entries()) {
      const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
      const source=ctx.getImageData(0,0,img.width,img.height).data;
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_CUBE_MAP_POSITIVE_X+i,tex,0);
      const status=gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER);
      if(status!==gl.FRAMEBUFFER_COMPLETE) throw Error('Incomplete cube attachment '+names[i]+': '+status);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      const data=new Uint8Array(source.length);gl.readPixels(0,0,img.width,img.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
      let changed=0,max=0;
      for(let j=0;j<data.length;j+=4) {
        let diff=0;
        for(let k=0;k<4;k++) diff=Math.max(diff,Math.abs(data[j+k]-source[j+k]));
        if (diff) changed++;
        max=Math.max(max,diff);
      }
      const pathname=new URL(img.currentSrc || img.src).pathname;
      const requests=performance.getEntriesByType('resource').filter(q=>new URL(q.name).pathname===pathname);
      faces.push({name:names[i],pathname,width:img.width,height:img.height,framebufferStatus:status,
        imageRGBA:await hash(source),gpuRGBA:await hash(data),differentPixels:changed,maxChannelError:max,
        requests:requests.map(q=>({http:q.responseStatus,encoded:q.encodedBodySize,decoded:q.decodedBodySize}))});
    }
  } finally {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,old.read);gl.readBuffer(old.readBuffer);gl.bindBuffer(gl.PIXEL_PACK_BUFFER,old.buffer);
    gl.pixelStorei(gl.PACK_ALIGNMENT,old.align);gl.pixelStorei(gl.PACK_ROW_LENGTH,old.row);
    gl.pixelStorei(gl.PACK_SKIP_ROWS,old.rows);gl.pixelStorei(gl.PACK_SKIP_PIXELS,old.pixels);
    gl.deleteFramebuffer(fbo);
  }
  const glasses=[];s.root.traverse(o=>{if(o.isMesh&&o.material?.name==='station-street-window')glasses.push(o.material.uniforms.uStreetEnvironment.value===cube);});
  return {time:w.island.timeOfDay,renderer:gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL),
    faces,panes:ref.stats.panes,glassCount:glasses.length,allGlassShare:glasses.every(Boolean),
    wetShares:r.properties.get(s.wetRoad.material).uniforms?.uStreetEnvironment?.value===cube,
    runtimeCaptures:ref.stats.captures,extraWetPasses:s.wetRoad.stats.extraPasses,beforeGL:before,afterGL:gl.getError()};
}
