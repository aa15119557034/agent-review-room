import * as T from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Opaque geometry supplies depth and view-space normals, including the goods
// behind glass. Transparent rain, glazing and ground decals never become ink.
export class ToonOutlinePass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.target = new T.WebGLRenderTarget(1, 1, {
      minFilter: T.LinearFilter, magFilter: T.LinearFilter, samples: 4,
      depthTexture: new T.DepthTexture(1, 1, T.UnsignedIntType)
    });
    this.normalMaterial = new T.MeshNormalMaterial();
    this.excluded = [];
    scene.traverse(object => {
      if (object.isLine || object.isPoints || object.isReflector ||
          (object.material && [object.material].flat().some(material => material.transparent))) {
        this.excluded.push(object);
      }
    });
    this.material = new T.ShaderMaterial({
      depthTest: false, depthWrite: false,
      uniforms: {
        tDiffuse: { value: null }, tNormal: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        texel: { value: new T.Vector2(1, 1) }, radius: { value: .9 },
        ink: { value: new T.Color('#1b2236') }
      },
      vertexShader: `varying vec2 vUv; void main() {
        vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
      }`,
      fragmentShader: `
        uniform sampler2D tDiffuse,tNormal,tDepth;
        uniform vec2 texel; uniform float radius; uniform vec3 ink;
        varying vec2 vUv;
        vec4 surface(vec2 offset) {
          vec2 uv=vUv+offset*texel*radius;
          return vec4(texture2D(tNormal,uv).rgb,texture2D(tDepth,uv).r);
        }
        void main() {
          vec4 a=surface(vec2(-1,1)),b=surface(vec2(0,1)),c=surface(vec2(1,1));
          vec4 d=surface(vec2(-1,0)),f=surface(vec2(1,0));
          vec4 g=surface(vec2(-1,-1)),h=surface(vec2(0,-1)),i=surface(vec2(1,-1));
          vec4 sx=-a-2.*d-g+c+2.*f+i,sy=a+2.*b+c-g-2.*h-i;
          float normalEdge=smoothstep(.55,1.30,sqrt(dot(sx.xyz,sx.xyz)+dot(sy.xyz,sy.xyz)));
          float depthEdge=smoothstep(.0035,.009,length(vec2(sx.w,sy.w)));
          float edge=max(normalEdge*.70,depthEdge);
          vec4 color=texture2D(tDiffuse,vUv);
          // Never brighten dark roof/wire silhouettes with the ink colour.
          gl_FragColor=vec4(mix(color.rgb,min(color.rgb*.45,ink),edge*.82),color.a);
        }
      `
    });
    this.quad = new FullScreenQuad(this.material);
    this.clearColor = new T.Color();
  }

  setSize(width, height) {
    this.target.setSize(width, height);
    this.material.uniforms.texel.value.set(1 / width, 1 / height);
    // A 1.8px silhouette at 1080p, independent of the camera's zoom/distance.
    this.material.uniforms.radius.value = .9 * height / 1080;
  }

  render(renderer, writeBuffer, readBuffer) {
    const { scene } = this;
    const previous = {
      background: scene.background, override: scene.overrideMaterial,
      autoClear: renderer.autoClear, shadowUpdate: renderer.shadowMap.autoUpdate,
      clearAlpha: renderer.getClearAlpha(), target: renderer.getRenderTarget()
    };
    renderer.getClearColor(this.clearColor);
    const visibility = this.excluded.map(object => object.visible);
    try {
      this.excluded.forEach(object => { object.visible = false; });
      scene.background = null;
      scene.overrideMaterial = this.normalMaterial;
      renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = true;
      renderer.setClearColor(0x8080ff, 1);
      renderer.setRenderTarget(this.target);
      renderer.clear();
      renderer.render(scene, this.camera);
    } finally {
      this.excluded.forEach((object, index) => { object.visible = visibility[index]; });
      scene.background = previous.background;
      scene.overrideMaterial = previous.override;
      renderer.shadowMap.autoUpdate = previous.shadowUpdate;
      renderer.autoClear = previous.autoClear;
      renderer.setClearColor(this.clearColor, previous.clearAlpha);
      renderer.setRenderTarget(previous.target);
    }
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.target.dispose();
    this.normalMaterial.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
