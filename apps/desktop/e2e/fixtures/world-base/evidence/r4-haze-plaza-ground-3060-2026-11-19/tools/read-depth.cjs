'use strict';
module.exports=async function readGroundDistance(){
  const w=window.worldBase,r=w.renderer,p=w.look.pipeline,T=await import('three');
  if(!window.__groundDepthReader){
    const rt=new T.WebGLRenderTarget(p.sceneRT.width,p.sceneRT.height,{depthBuffer:false,type:T.UnsignedByteType,minFilter:T.NearestFilter,magFilter:T.NearestFilter});
    const mat=new T.RawShaderMaterial({glslVersion:T.GLSL3,depthWrite:false,depthTest:false,uniforms:{
      tDepth:p.uDepth,proj:{value:w.camera.projectionMatrixInverse},reversed:{value:p.reversed?1:0}},vertexShader:
      'in vec3 position;out vec2 uv;void main(){uv=position.xy*.5+.5;gl_Position=vec4(position.xy,0.,1.);}',fragmentShader:
      'precision highp float;uniform highp sampler2D tDepth;uniform mat4 proj;uniform int reversed;in vec2 uv;out vec4 pixel;void main(){float z=texelFetch(tDepth,ivec2(gl_FragCoord.xy),0).r;vec4 v=proj*vec4(uv*2.-1.,reversed==1?z:z*2.-1.,1.);float d=length(v.xyz/v.w);float k=(abs(z-(reversed==1?0.:1.))<1.e-8)?0.:(d<60.?1.:(d<120.?2.:(d<300.?3.:(d<530.?4.:(d<850.?5.:6.)))));pixel=vec4(k/255.,0.,0.,1.);}'});
    window.__groundDepthReader={rt,mat};
  }
  const {rt,mat}=window.__groundDepthReader,prev=r.getRenderTarget(),m=p.quad.material;
  p._blit(mat,rt);const raw=new Uint8Array(rt.width*rt.height*4);r.readRenderTargetPixels(rt,0,0,rt.width,rt.height,raw);p.quad.material=m;r.setRenderTarget(prev);
  const bits=new Uint8Array(rt.width*rt.height),bins=[0,0,0,0,0,0,0];
  for(let y=0;y<rt.height;y++)for(let x=0;x<rt.width;x++){let v=raw[((rt.height-1-y)*rt.width+x)*4];if(v>6)throw Error('Bad depth band');bits[y*rt.width+x]=v;bins[v]++;}
  if(!bins.slice(1).some(v=>v>0)||r.getContext().getError())throw Error('Depth readback failed');
  let base='';for(let i=0;i<bits.length;i+=16384)base+=String.fromCharCode(...bits.subarray(i,i+16384));
  return {map:btoa(base),bins};
};
