'use strict';

// Recreate the fixed stratified draw on the original pinned island (no WebGL).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname,'../..');
const assets = path.join(root,'.local/petalwake-25443cef0eba802052d9ef24c94ba3c4157b6f2e/assets');
const meta = JSON.parse(fs.readFileSync(path.join(assets,'terrain/meta.json')));
const heights = fs.readFileSync(path.join(assets,'terrain/height.u16'));
const sites = JSON.parse(fs.readFileSync(path.join(assets,'town/sites.json'),'utf8')).towns;
const round = x => Math.round(x * 10000) / 10000;
let seed = 252; // The art-direction issue number.
function uniform() {
  seed=(seed+0x6D2B79F5)>>>0;
  let t=Math.imul(seed^(seed>>>15),1|seed);
  t=(t+Math.imul(t^(t>>>7),61|t))^t;
  return ((t^(t>>>14))>>>0)/4294967296;
}
function ground(x,z) {
  const fx=(x+meta.world/2)/meta.cell-0.5, fz=(z+meta.world/2)/meta.cell-0.5;
  const ix=Math.floor(fx), iz=Math.floor(fz), tx=fx-ix, tz=fz-iz;
  const at=(i,j)=>Math.fround(meta.hMin+heights.readUInt16LE(2*(j*meta.n+i))*(meta.hMax-meta.hMin)/65535);
  return (at(ix,iz)*(1-tx)+at(ix+1,iz)*tx)*(1-tz)+(at(ix,iz+1)*(1-tx)+at(ix+1,iz+1)*tx)*tz;
}
function streetPoint(town,street,fraction) {
  const points=sites.find(item=>item.id===town).streets.find(s=>s.key===street).pts;
  const lengths=points.slice(1).map((b,i)=>Math.hypot(b[0]-points[i][0],b[1]-points[i][1]));
  let travel=lengths.reduce((a,b)=>a+b,0)*fraction;
  for(let i=0;i<lengths.length;i++){
    if(travel<=lengths[i]) return points[i].map((v,j)=>round(v+(points[i+1][j]-v)*travel/lengths[i]));
    travel-=lengths[i];
  }
  return points.at(-1);
}
const standing=([x,z])=>[x,round(ground(x,z)+1.60),z];
// E uses the middle three quarters of the quay. F uses the mountain foot's existing meadow.
// G samples the north railway lane clear of its crossing. H uses the original public approach to the tower.
const e=streetPoint('larkhaven','quay',0.125+0.75*uniform());
const f=[round(997+70*uniform()),round(553+50*uniform())];
let railX;do {railX=round(-80+160*uniform());} while(Math.abs(railX+12)<9);
const h=streetPoint('cairnwick','tower',0.05+0.60*uniform());
const specs={
  'sample-e-harbour':{position:standing(e),target:[-24,7.2,1123.5]},
  'sample-f-hillside':{position:standing(f),target:[1062,round(ground(1062,490)+8),490]},
  'sample-g-rail':{position:[round(280+railX),9.6,844.5],target:[268,10.55,857]},
  'sample-h-north':{position:standing(h),target:[180,141.45,-1238]},
};
if (process.argv[2]==='verify') {
  const report=JSON.parse(fs.readFileSync(path.join(__dirname,'report.json'),'utf8'));
  for(const [name,pose] of Object.entries(specs)) {
    assert.deepEqual(report.photos[name].eye,pose.position);
    assert.deepEqual(report.photos[name].view.target,pose.target);
  }
  console.log('Seed 252 reproduced all four fixed poses.');
} else {
  console.log(JSON.stringify(specs,null,2));
}
