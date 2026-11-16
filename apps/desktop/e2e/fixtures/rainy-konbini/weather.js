import * as T from 'three';
import { paintedLightPools } from './light-pools.js';
import { clusteredPuddles } from './puddles.js';

export function weather(scene,c,shop) {
  let seed=281;const random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
  const time={value:0};
  const geometry=new T.BufferGeometry(),positions=[],phases=[];
  for(let i=0;i<900;i++){
    let x,z;do{x=random()*13-6.5;z=random()*13-6.5;}while(x>-5.9&&x<2.1&&z>-5.1&&z<2.1);
    const phase=random();for(const y of [0,.10+random()*.10]){positions.push(x,y,z);phases.push(phase);}
  }
  geometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));geometry.setAttribute('phase',new T.Float32BufferAttribute(phases,1));
  const rain=new T.LineSegments(geometry,new T.ShaderMaterial({
    uniforms:{time},transparent:true,depthWrite:false,
    vertexShader:`attribute float phase;uniform float time;varying float vHeight;void main(){vec3 p=position;float h=mod(phase*9.0-time*5.2,9.0);p.y+=h;p.x+=p.y*.045;vHeight=p.y;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`,
    fragmentShader:`varying float vHeight;void main(){float a=.17*smoothstep(.07,.4,vHeight)*(1.-smoothstep(5.,8.,vHeight));gl_FragColor=vec4(.50,.64,.77,a);}`
  }));rain.name='continuous-rain';rain.frustumCulled=false;scene.add(rain);
  const ground=paintedLightPools(scene,time);
  const puddles=clusteredPuddles(scene,time,random),ripples=puddles.ripples;
  const dripGeo=new T.BufferGeometry(),dp=[],dph=[];
  for(let i=0;i<40;i++){const x=-5.7+random()*7.8;for(const y of [0,.095]){dp.push(x,y,2.04);dph.push(random()+i*.025);}}
  // Both vertices of each drip share a phase so segments keep a short length.
  for(let i=0;i<dph.length;i+=2)dph[i+1]=dph[i];
  dripGeo.setAttribute('position',new T.Float32BufferAttribute(dp,3));dripGeo.setAttribute('phase',new T.Float32BufferAttribute(dph,1));
  const drips=new T.LineSegments(dripGeo,new T.ShaderMaterial({uniforms:{time},transparent:true,depthWrite:false,
    vertexShader:`attribute float phase;uniform float time;void main(){vec3 p=position;p.y+=.30+mod(phase*3.-time*3.7,3.);gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
    fragmentShader:`void main(){gl_FragColor=vec4(.86,.82,.63,.43);}`}));drips.name='eave-drips';drips.frustumCulled=false;scene.add(drips);
  const streakMaterial=new T.ShaderMaterial({uniforms:{time},transparent:true,depthWrite:false,side:T.DoubleSide,
    vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`uniform float time;varying vec2 vUv;void main(){float cell=floor(vUv.x*24.);float seed=fract(sin(cell*47.31)*4321.);float x=fract(vUv.x*24.);float y=fract(vUv.y*3.0+time*(.10+seed*.13)+seed*11.);float drop=(1.-smoothstep(.025,.11,abs(x-.5)))*smoothstep(.72,.98,y)*(.25+seed*.55);float thin=(1.-smoothstep(.004,.018,abs(x-.5)))*smoothstep(.35,.9,y)*.20;gl_FragColor=vec4(.60,.84,.88,(drop+thin)*.26);}`});
  const streaks=new T.Group();streaks.name='glass-rain-trails';scene.add(streaks);
  for(const [x,w]of[[-4.34,2.47],[-2.38,1.20],[.95,1.52]]){const pane=new T.Mesh(new T.PlaneGeometry(w,2.25),streakMaterial);pane.position.set(x,1.83,1.28);pane.renderOrder=3;streaks.add(pane);}
  for(const leaf of [shop.doorLeft,shop.doorRight]){const pane=new T.Mesh(new T.PlaneGeometry(.82,2.25),streakMaterial);pane.position.set(0,1.47,.045);pane.renderOrder=3;leaf.add(pane);}
  return {rain,ground,puddles,ripples,drips,streaks,update(t,signalColor){time.value=t;ground.signal.value.copy(signalColor);}};
}
