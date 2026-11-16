import * as T from 'three';

// Painted light belongs to the ground plane, not to bloom or a reflected camera.
// Separate road/sidewalk receivers preserve the kerb height and remain occluded
// by bikes, railings and paving details in the regular depth buffer.
export function paintedLightPools(scene, time) {
  const group = new T.Group(); group.name = 'painted-rain-light'; scene.add(group);
  const vertexShader = `varying vec2 vUv; varying vec3 vWorld; void main(){
    vUv=uv; vWorld=(modelMatrix*vec4(position,1.)).xyz;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
  }`;
  const fragmentShader = `
    uniform float time,strength,shape,sidewalk; uniform vec3 tint;
    varying vec2 vUv; varying vec3 vWorld;
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
    void main(){
      if(abs(vWorld.x)>6.91||abs(vWorld.z)>6.91)discard;
      bool onPaving=vWorld.x>-6.4&&vWorld.x<3.3&&vWorld.z>-6.525&&vWorld.z<3.125;
      if(onPaving!=(sidewalk>.5))discard;
      vec2 q=vec2(vUv.x*2.-1.,1.-vUv.y);
      q.x+=sin(q.y*63.+time*1.3)*.012+sin(q.y*29.-time*.7)*.009;
      float mask;
      if(shape<.5){
        float width=.64+.32*q.y;
        mask=(1.-smoothstep(width-.15,width,abs(q.x)))*smoothstep(0.,.09,q.y)*(1.-smoothstep(.20,1.,q.y));
      }else if(shape<1.5){
        mask=1.-smoothstep(.12,1.,length(vec2(q.x,(q.y-.5)*2.)));
      }else{
        mask=(1.-smoothstep(.52,1.,abs(q.x)))*smoothstep(0.,.13,q.y)*(1.-smoothstep(.35,1.,q.y));
      }
      float brush=.66+.24*noise(vec2(vWorld.x*5.,vWorld.z*19.+sin(time*.5)*.10));
      float sheen=.88+.12*sin(q.y*110.+sin(q.x*19.)*.8+time*.65);
      gl_FragColor=vec4(tint,strength*mask*brush*sheen);
    }
  `;
  const pools = [];
  function pool(name,x,z,width,length,color,strength,shape,heading=0) {
    const tint = {value:new T.Color(color)};
    const geometry = new T.PlaneGeometry(width,length);
    for(const sidewalk of [0,1]) {
      const material=new T.ShaderMaterial({
        uniforms:{time,tint,strength:{value:strength},shape:{value:shape},sidewalk:{value:sidewalk}},
        vertexShader,fragmentShader,transparent:true,depthWrite:false,blending:T.AdditiveBlending
      });
      const mesh=new T.Mesh(geometry,material);
      mesh.name=name+(sidewalk?'-pavement':'-road');
      mesh.rotation.order='YXZ';mesh.rotation.set(-Math.PI/2,heading,0);
      mesh.position.set(x,sidewalk?.277:.075,z);mesh.renderOrder=2;group.add(mesh);
    }
    pools.push({name,x,z,width,length});
    return tint;
  }
  pool('shop-amber-fan',-1.90,3.86,7.8,5.3,'#f8bd75',.66,0);
  pool('streetlamp-warm-pool',5.03,3.55,3.35,4.2,'#f3c17c',.52,1);
  pool('vending-cyan-reflection',2.54,2.20,1.65,3.3,'#6acbd5',.54,2);
  const signal=pool('signal-changing-streak',5.75,5.40,.82,2.65,'#69c5a4',.32,2,.20);
  return {group,pools,signal,time};
}
