// CPU analytical plane counterexample only; no renderer or GPU.
import fs from 'node:fs';
import crypto from 'node:crypto';
const root="D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base";
const W=1440,H=900, near=.2,far=16000;
const smooth=(a,b,x)=>{let t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t)};
function ao(xPixel,clampTexture,boundaryGuard=false){
 const uv=(xPixel+.5)/W, inv=u=>.1+.15*u, d0=1/inv(uv);
 const r=Math.min(48,Math.max(3,.8*(.5*H/Math.tan(58*Math.PI/360))/d0));
 let occ=0,outOfBoundsPairs=0,skippedPairs=0;
 const sample=u=>{let px=Math.floor(u*W);if(clampTexture)px=Math.max(0,Math.min(W-1,px));return inv((px+.5)/W);};
 for(let i=0;i<8;i++)for(let k=0;k<2;k++){
  const dx=Math.cos(i*.3927+.2)/W*r*(k===0?.45:1);
  if(uv+dx<0||uv-dx<0||uv+dx>1||uv-dx>1)outOfBoundsPairs++;
  const dy=Math.sin(i*.3927+.2)/H*r*(k===0?.45:1);
  if(boundaryGuard && (uv+dx<.5/W||uv-dx<.5/W||uv+dx>1-.5/W||uv-dx>1-.5/W||.5+dy<.5/H||.5-dy<.5/H||.5+dy>1-.5/H||.5-dy>1-.5/H)){skippedPairs++;continue;}
  const dz=(.5*(sample(uv+dx)+sample(uv-dx))-inv(uv))*d0*d0;
  occ+=smooth(Math.max(.08,.012*d0),Math.max(.08,.012*d0)+.35,dz)*(1-smooth(1.2,2.4,dz));
 }
 return {xPixel,d0,r,outOfBoundsPairs,skippedPairs,ao:1-occ/16,compositeMultiplier:1-.55*occ/16};
}
const report={scope:'CPU mathematical replay of the original single-plane counterexample with the reviewed two-dimensional texel-center guard. Not GLSL compilation, not GPU validation; denominator remains16.',sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(root+'/src/look.js')).digest('hex'),cases:[0,1,10,47,100].map(x=>({x,old:ao(x,true),fixed:ao(x,true,true)}))};
console.log(JSON.stringify(report,null,2));
