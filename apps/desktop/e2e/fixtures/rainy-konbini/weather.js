import * as T from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

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
  // A single reflected view, broken into shallow wet patches and gently distorted.
  const reflectionShader={
    uniforms:{...Reflector.ReflectorShader.uniforms,time},
    vertexShader:`uniform mat4 textureMatrix;varying vec4 vReflect;varying vec3 vWorld;void main(){vReflect=textureMatrix*vec4(position,1.);vWorld=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`uniform sampler2D tDiffuse;uniform vec3 color;uniform float time;varying vec4 vReflect;varying vec3 vWorld;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
      void main(){if(vWorld.z<3.25&&vWorld.x<3.49)discard;vec2 uv=vReflect.xy/vReflect.w;
      float n=noise(vWorld.xz*1.8);float wetArea=smoothstep(.25,.68,n);vec2 ripple=vec2(sin(vWorld.z*48.+time*2.6),cos(vWorld.x*32.+time*1.7))*.0007;
      vec3 reflected=texture2D(tDiffuse,uv+ripple).rgb*.5+texture2D(tDiffuse,uv+ripple+vec2(.0015,.0006)).rgb*.25+texture2D(tDiffuse,uv+ripple-vec2(.0015,.0006)).rgb*.25;
      gl_FragColor=vec4(reflected*vec3(.80,.90,1.),.15+.45*wetArea);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`
  };
  const wet=new Reflector(new T.PlaneGeometry(13.84,13.84),{textureWidth:1024,textureHeight:1024,multisample:0,clipBias:.003,shader:reflectionShader,color:0xffffff});
  wet.name='wet-asphalt-reflections';wet.rotation.x=-Math.PI/2;wet.position.y=.072;wet.material.transparent=true;wet.material.depthWrite=false;wet.renderOrder=1;scene.add(wet);
  // Expanding circles are surface ripples, not a screen overlay.
  const rippleMaterial=new T.ShaderMaterial({uniforms:{time},transparent:true,depthWrite:false,side:T.DoubleSide,
    vertexShader:`attribute float phase;varying vec2 vUv;varying float vPhase;void main(){vUv=uv;vPhase=phase;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.);}`,
    fragmentShader:`uniform float time;varying vec2 vUv;varying float vPhase;void main(){float t=fract(time*.68+vPhase);float r=length((vUv-.5)*2.);float ring=1.-smoothstep(.012,.035,abs(r-t*.95));float echo=(1.-smoothstep(.01,.025,abs(r-t*.6)))*.3;gl_FragColor=vec4(.56,.74,.83,(ring+echo)*(1.-t)*.40);}`});
  const rippleGeo=new T.PlaneGeometry(.76,.76);rippleGeo.rotateX(-Math.PI/2);
  const count=90;const ripples=new T.InstancedMesh(rippleGeo,rippleMaterial,count),phaseArray=new Float32Array(count),dummy=new T.Object3D();
  for(let i=0;i<count;i++){let x,z;do{x=random()*13-6.5;z=random()*13-6.5;}while(x<3.65&&z<3.45);dummy.position.set(x,.086,z);dummy.scale.setScalar(.4+random()*.9);dummy.updateMatrix();ripples.setMatrixAt(i,dummy.matrix);phaseArray[i]=random();}
  rippleGeo.setAttribute('phase',new T.InstancedBufferAttribute(phaseArray,1));ripples.name='puddle-ripples';scene.add(ripples);
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
  return {rain,wet,ripples,drips,streaks,update(t){time.value=t;wet.material.uniforms.time.value=t;}};
}
