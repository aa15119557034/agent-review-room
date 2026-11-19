import * as THREE from 'three';
import { ENV, U } from '../upstream/petalwake/src/core/ctx.js';
import { SEA_STATE } from '../upstream/petalwake/src/world/water.js';

// A compressed coastal front, followed by cooling of moist ground in light wind.
// Pressure (hPa), air/dew point (°C), wind toward x/z (m/s), cloud, lift and ground wetness.
const fronts = [
  [0,   1017, 19, 13, 1.5, 2.0, 0.00, 0.00, 0.00],
  [24,  1013, 19, 16, 3.0, 4.2, 0.52, 0.10, 0.00],
  [43,  1008, 17, 16.7, 5.4, 6.8, 1.0, 0.90, 0.52],
  [54,  1007, 16, 15.9, 6.0, 6.1, 1.0, 1.00, 1.00],
  [72,  1011, 15, 13.5, 5.7, 1.1, 0.56, 0.04, 0.94],
  [97,  1016, 16, 11.7, 3.0, 0.6, 0.06, 0.00, 0.60],
  [133, 1019, 14, 12.3, 1.0, 0.6, 0.08, 0.00, 0.43],
  [164, 1020, 12.2, 12.1, 0.4, 0.4, 0.12, 0.00, 0.38],
  [186, 1020, 12.0, 11.9, 0.4, 0.5, 0.13, 0.00, 0.33],
  [215, 1019, 16, 12.4, 1.0, 1.9, 0.06, 0.00, 0.17],
  [240, 1017, 19, 13, 1.5, 2.0, 0.00, 0.00, 0.00],
];
// A drier ridge and a stronger marine front follow the first passage. All three
// meet at the same fair-weather boundary, including integrated cloud travel.
const regimes=[
  {name:'海洋冷锋',duration:240,severity:1,moisture:1},
  {name:'干燥高压脊',duration:195,severity:0.28,moisture:0.23},
  {name:'湿润强锋',duration:280,severity:1.22,moisture:1.16},
];
let cycle=0, drift=[0,0];
for(const regime of regimes){
  regime.start=cycle;regime.origin=drift;
  const {severity,moisture,duration}=regime;
  regime.rows=fronts.map(([time,p,t,dew,x,z,cloud,lift,wet])=>{
    const activity=Math.sin(Math.PI*time/240)**2;
    const air=19+(t-19)*Math.min(severity,1.15);
    return [time*duration/240,1017+(p-1017)*severity,air,
      air-Math.max(0.05,(t-dew)+(1-moisture)*7*activity),
      1.5+(x-1.5)*severity,2+(z-2)*severity,Math.min(1,cloud*severity),Math.min(1,lift*severity),Math.min(1,wet*moisture)];
  });
  regime.travel=[[0,0]];
  for(let j=1;j<regime.rows.length;j++){
    const a=regime.rows[j-1],b=regime.rows[j],dt=b[0]-a[0];
    regime.travel.push([4,5].map((k,i)=>regime.travel[j-1][i]+0.5*(a[k]+b[k])*dt));
  }
  drift=drift.map((v,i)=>v+regime.travel.at(-1)[i]);cycle+=duration;
}
export function createWeather(timeOfDay) {
  const palette = ENV[timeOfDay];
  const overcast = {
    sunColor: [0.94, 0.91, 0.95], zenith: [0.10, 0.15, 0.25], mid: [0.25, 0.34, 0.46],
    horizon: [0.53, 0.57, 0.64], halo: [0.25, 0.22, 0.25],
    ambSky: [0.34, 0.40, 0.52], ambGround: [0.19, 0.20, 0.18],
  };
  const fields = { sunColor: U.uSunColor, zenith: U.uSkyZenith, mid: U.uSkyMid, horizon: U.uSkyHorizon,
    halo: U.uSunHalo, ambSky: U.uAmbSky, ambGround: U.uAmbGround };
  const colors = Object.entries(fields).map(([key, uniform]) => [
    uniform.value, new THREE.Vector3(...palette[key]), new THREE.Vector3(...overcast[key]),
  ]);
  const state = {seconds:0,phase:'晴',cover:0,rain:0,fog:0};
  function update(seconds) {
    const local=seconds%cycle, lap=Math.floor(seconds/cycle);
    const regime=regimes.find(r=>local<r.start+r.duration);
    const t=local-regime.start,rows=regime.rows;
    const j=rows.findIndex((row,index)=>index>0 && row[0]>t)-1;
    const a=rows[j], b=rows[j+1], dt=b[0]-a[0], s=(t-a[0])/dt;
    const k=s*s*(3-2*s), interp=i=>THREE.MathUtils.lerp(a[i],b[i],k);
    const pressure=interp(1), temperature=interp(2), dewPoint=interp(3);
    const wx=interp(4), wz=interp(5), windSpeed=Math.hypot(wx,wz), cover=interp(6);
    const moist=1-THREE.MathUtils.smoothstep(temperature-dewPoint,0.25,3);
    const rain=cover*moist*interp(7)*THREE.MathUtils.smoothstep(1017-pressure,1,8), wetness=interp(8);
    const fog=moist*(1-THREE.MathUtils.smoothstep(windSpeed,0.65,2.3))*(1-cover)*Math.min(1,wetness*4);
    // Integral of the smooth wind transition, continuous across knots and repeated fronts.
    const integral=s*s*s*(1-0.5*s);
    const advect=i=>lap*drift[i]+regime.origin[i]+regime.travel[j][i]+dt*(s*a[4+i]+integral*(b[4+i]-a[4+i]));
    U.uCloudFlow.value.set(advect(0),advect(1),cover,seconds*0.00065);
    U.uWind.value.set(wx/windSpeed,wz/windSpeed,0.64+0.115*windSpeed,0);
    for (const [value, clear, grey] of colors) value.lerpVectors(clear, grey, cover);
    U.uFog.value.x=palette.fog[0]+0.0009*cover+0.00075*rain+0.009*fog;
    U.uFog.value.y=palette.fog[1]+0.034*fog;
    SEA_STATE.value=0.52+0.073*windSpeed;
    U.uSeaSetup.value=0.19*cover;
    const phase=rain>0.14?'锋面阵雨':fog>0.22?'辐射雾':interp(7)<0.12 && wetness>0.52?'雨后放晴':cover>0.25?'海上低云':'晴间多云';
    Object.assign(state,{seconds,regime:regime.name,phase,cover,rain,fog,wetness,windSpeed,pressure,temperature,dewPoint,
      wind:U.uWind.value.z,sea:SEA_STATE.value,surge:U.uSeaSetup.value});
  }
  update(0);
  return { state, update };
}
