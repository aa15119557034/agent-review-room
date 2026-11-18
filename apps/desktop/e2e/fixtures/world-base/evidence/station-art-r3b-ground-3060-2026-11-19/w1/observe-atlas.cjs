function observePrintedCards(mesh, items) {
  for (const {o, tile} of items) {
    const source=o.material;
    if (!source.name.startsWith('art-r3-w1-zone-')) continue;
    const before=source.map.image;
    const after=mesh.material.map.image;
    const x=Math.round(tile.u0*after.width);
    const y=Math.round((1-tile.v0-tile.sv)*after.height);
    const width=before.width, height=before.height;
    const extract=(image,left,top)=>image.getContext('2d').getImageData(left,top,width,height).data;
    const original=extract(before,0,0), packed=extract(after,x,y);
    let different=0, delta=0;
    for (let i=0; i<original.length; i+=4) {
      let pixel=0;
      for (let j=0; j<4; j++) pixel=Math.max(pixel,Math.abs(original[i+j]-packed[i+j]));
      if (pixel) different++;
      delta=Math.max(delta,pixel);
    }
    (window.__w1Cards??=[]).push({
      name:source.name, sourceMaterial:source.type, batchMaterial:mesh.material.type,
      sourceRGB:source.color.toArray(), vertexColors:mesh.material.vertexColors,
      groupObjectCount:items.length, groupIndex:mesh.parent.children.indexOf(mesh),
      sourcePixels:[width,height], atlasSize:[after.width,after.height], atlasPage:tile.page,
      atlasPixels:[x,y,width,height], differentPixels:different, maxChannelDifference:delta
    });
  }
}
