import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const species = [
  { name:'oak', height:12, bark:'oak' }, { name:'aspen', height:14, bark:'birch' },
  { name:'pine', height:17, bark:'pine' }, { name:'ash', height:9, bark:'oak' },
];
const asset = file => new URL('./woodland/'+file,import.meta.url).href;

export async function loadWoodlandModels() {
  const loader = new THREE.TextureLoader(), cache = new Map();
  function texture(file,repeat) {
    if (!cache.has(file)) cache.set(file,loader.loadAsync(asset(file)).then(t=>{
      if(file==='aspen.png'){
        // The source is bright autumn gold. Regrade just the leaves to early-season
        // yellow-green; the same material is used to bake the distant silhouettes.
        const canvas=document.createElement('canvas');canvas.width=t.image.width;canvas.height=t.image.height;
        const ctx=canvas.getContext('2d');ctx.drawImage(t.image,0,0);
        const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),a=pixels.data;
        for(let i=0;i<a.length;i+=4){
          const gold=Math.max(0,(a[i]-a[i+1])/255),red=a[i];
          a[i]*=0.78-0.21*gold;a[i+1]=a[i+1]*0.85+red*0.18;a[i+2]+=red*0.075;
        }
        ctx.putImageData(pixels,0,0);t.image=canvas;t.needsUpdate=true;
      }
      t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=8;
      if(repeat) t.wrapS=t.wrapT=THREE.RepeatWrapping;
      return t;
    }));
    return cache.get(file);
  }
  const [gltf,materials]=await Promise.all([
    new GLTFLoader().loadAsync(asset('trees.glb')),
    Promise.all(species.map(async s=>{
      const [bark,leaves]=await Promise.all([texture(s.bark+'-bark.jpg',true),texture(s.name+'.png',false)]);
      return [
        new THREE.MeshLambertMaterial({map:bark}),
        new THREE.MeshLambertMaterial({map:leaves,side:THREE.DoubleSide,alphaTest:0.37,alphaToCoverage:true}),
      ];
    })),
  ]);
  return species.flatMap((s,index)=>[0,1].map(v=>{
    const tree=gltf.scene.getObjectByName(s.name+v);
    const parts=tree.children.map(mesh=>{
      const leaf=mesh.material.name.endsWith('-leaves');
      mesh.material=materials[index][Number(leaf)];
      return {mesh,leaf};
    });
    return {tree,parts,height:s.height,species:s.name};
  }));
}

export async function loadForestAtlas() {
  const texture=await new THREE.TextureLoader().loadAsync(asset('distant.png'));
  texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=4;
  return texture;
}
