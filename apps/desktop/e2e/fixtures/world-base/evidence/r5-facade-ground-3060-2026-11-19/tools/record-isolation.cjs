'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { nativeImage } = require('electron');
const compareTheSameWorldFrame = require('./facade-isolate-page.cjs');
function difference(a,b) {
  if (a.length!==b.length) throw Error('Frame sizes differ');
  let changed=0, over2=0, max=0;
  for (let i=0;i<a.length;i+=4) {
    let delta=0;
    for (let c=0;c<4;c++) delta=Math.max(delta,Math.abs(a[i+c]-b[i+c]));
    if (delta) changed++;
    if (delta>2) over2++;
    max=Math.max(max,delta);
  }
  return {changed,over2,max};
}
module.exports = async function recordIsolation(webContents,out,key) {
  const shot=await webContents.executeJavaScript('('+compareTheSameWorldFrame.toString()+')()');
  const pixels={};
  for (const variant of ['refined','baseline','restored']) {
    const png=Buffer.from(shot[variant],'base64');
    const image=nativeImage.createFromBuffer(png),size=image.getSize();
    if(size.width!==1440||size.height!==900)throw Error('Unexpected comparison canvas');
    pixels[variant]=image.toBitmap();
    if(['art-c-alley','art-d-laundry','sample-e-harbour','sample-g-rail'].includes(key)&&variant!=='restored')
      fs.writeFileSync(path.join(out,key+'-'+variant+'.png'),png);
    delete shot[variant];
  }
  return {...shot,refinedVsBase:difference(pixels.refined,pixels.baseline),refinedVsReturn:difference(pixels.refined,pixels.restored)};
};
