import * as T from 'three';

const shore = `
  float puddleMask(vec2 world,vec4 basin){
    vec2 q=(world-basin.xy)/basin.zw;float angle=atan(q.y,q.x);
    float boundary=.90+.045*sin(angle*5.+basin.x)+.025*sin(angle*9.+basin.y);
    return 1.-smoothstep(boundary-.07,boundary,length(q));
  }
`;

export function clusteredPuddles(scene,time,random) {
  const patches=[
    {name:'warm-shop-puddle',x:-1.30,z:4.60,rx:2.15,rz:.69,y:.078,color:'#dbad78',count:8},
    {name:'warm-lamp-puddle',x:4.94,z:3.82,rx:1.15,rz:.87,y:.078,color:'#d9b47f',count:6},
    {name:'cool-side-puddle',x:4.53,z:-1.70,rx:.72,rz:1.68,y:.078,color:'#739db8',count:5},
    {name:'cyan-vending-puddle',x:2.10,z:-6.29,rx:.88,rz:.19,y:.280,color:'#78bdc6',count:3},
    {name:'cool-front-puddle',x:1.92,z:6.06,rx:1.28,rz:.38,y:.078,color:'#739db8',count:4},
    {name:'service-door-puddle',x:-.15,z:-5.85,rx:.83,rz:.40,y:.280,color:'#e0bd89',count:4}
  ];
  const group=new T.Group();group.name='clustered-puddles';scene.add(group);
  const tint=new T.Color();
  for(const patch of patches){
    const surface=new T.Mesh(new T.PlaneGeometry(patch.rx*2,patch.rz*2),new T.ShaderMaterial({
      uniforms:{basin:{value:new T.Vector4(patch.x,patch.z,patch.rx,patch.rz)},tint:{value:new T.Color(patch.color)}},
      transparent:true,depthWrite:false,
      vertexShader:`varying vec3 vWorld;void main(){vWorld=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader:`uniform vec4 basin;uniform vec3 tint;varying vec3 vWorld;${shore}
        void main(){float mask=puddleMask(vWorld.xz,basin);float rim=4.*mask*(1.-mask);
          gl_FragColor=vec4(tint*.38,(.085*mask+.16*rim));}`
    }));
    surface.name=patch.name;surface.rotation.x=-Math.PI/2;surface.position.set(patch.x,patch.y,patch.z);surface.renderOrder=1;group.add(surface);
  }
  const geometry=new T.PlaneGeometry(.68,.68);geometry.rotateX(-Math.PI/2);
  const count=patches.reduce((sum,patch)=>sum+patch.count,0);
  const phases=new Float32Array(count),colors=new Float32Array(count*3),patchData=new Float32Array(count*4);
  const material=new T.ShaderMaterial({
    uniforms:{time},transparent:true,depthWrite:false,side:T.DoubleSide,
    vertexShader:`attribute float phase;attribute vec3 rippleColor;attribute vec4 puddle;
      varying vec2 vUv;varying float vPhase;varying vec3 vColor;varying vec4 vPatch;varying vec3 vWorld;
      void main(){vUv=uv;vPhase=phase;vColor=rippleColor;vPatch=puddle;
        vWorld=(modelMatrix*instanceMatrix*vec4(position,1.)).xyz;
        gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.);}`,
    fragmentShader:`uniform float time;varying vec2 vUv;varying float vPhase;varying vec3 vColor;varying vec4 vPatch;varying vec3 vWorld;${shore}
      void main(){float t=fract(time*.52+vPhase),r=length((vUv-.5)*2.);
        float ring=1.-smoothstep(.016,.042,abs(r-t*.94));
        float echo=(1.-smoothstep(.012,.029,abs(r-t*.58)))*.20;
        float fade=smoothstep(0.,.14,t)*(1.-t);
        gl_FragColor=vec4(vColor,min(1.,ring+echo)*fade*.18*puddleMask(vWorld.xz,vPatch));}`
  });
  const ripples=new T.InstancedMesh(geometry,material,count),dummy=new T.Object3D();
  let index=0;
  for(const patch of patches)for(let i=0;i<patch.count;i++){
    const angle=random()*Math.PI*2,radius=Math.sqrt(random())*.62;
    dummy.position.set(patch.x+Math.cos(angle)*patch.rx*radius,patch.y+.006,patch.z+Math.sin(angle)*patch.rz*radius);
    dummy.scale.setScalar(Math.min(.52+random()*.42,Math.min(patch.rx,patch.rz)*1.8));dummy.updateMatrix();ripples.setMatrixAt(index,dummy.matrix);
    phases[index]=random();tint.set(patch.color).toArray(colors,index*3);
    patchData.set([patch.x,patch.z,patch.rx,patch.rz],index*4);index++;
  }
  geometry.setAttribute('phase',new T.InstancedBufferAttribute(phases,1));
  geometry.setAttribute('rippleColor',new T.InstancedBufferAttribute(colors,3));
  geometry.setAttribute('puddle',new T.InstancedBufferAttribute(patchData,4));
  ripples.name='subtle-puddle-ripples';ripples.renderOrder=3;group.add(ripples);
  return {group,ripples,patches,opacity:.18};
}
