import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Original procedural assets. Dimensions are metres; Y is up, the shop faces +Z.
export function craft(scene) {
  const root = new T.Group(); root.name = 'ameakari-diorama'; scene.add(root);
  const features = {}, materials = new Map(), geometries = new Map();
  const bands = new T.DataTexture(new Uint8Array([55, 105, 175, 255]), 4, 1, T.RedFormat);
  bands.minFilter = bands.magFilter = T.NearestFilter; bands.needsUpdate = true;
  const ink = new T.LineBasicMaterial({ color: 0x172332, transparent: true, opacity: .58 });
  function toon(color, emission = 0) {
    const key = `${color}/${emission}`;
    if (!materials.has(key)) materials.set(key, new T.MeshToonMaterial({ color, gradientMap: bands, emissive: color, emissiveIntensity: emission }));
    return materials.get(key);
  }
  function glow(color, power = 1) { return new T.MeshBasicMaterial({ color: new T.Color(color).multiplyScalar(power), toneMapped: false }); }
  function mesh(geometry, material, xyz, parent = root, name = '') {
    const m = new T.Mesh(geometry, material); m.position.set(...xyz); m.castShadow = true; m.receiveShadow = true; m.name = name; parent.add(m); return m;
  }
  function box(w,h,d,x,y,z,mat,parent=root,r=.025) {
    const k=`b/${w}/${h}/${d}/${r}`;
    if(!geometries.has(k)) geometries.set(k,r>0?new RoundedBoxGeometry(w,h,d,2,Math.min(r,w/4,h/4,d/4)):new T.BoxGeometry(w,h,d));
    return mesh(geometries.get(k),mat,[x,y,z],parent);
  }
  function cylinder(rt,rb,h,x,y,z,mat,parent=root,segments=20) {
    const k=`c/${rt}/${rb}/${h}/${segments}`;
    if(!geometries.has(k))geometries.set(k,new T.CylinderGeometry(rt,rb,h,segments));
    return mesh(geometries.get(k),mat,[x,y,z],parent);
  }
  function sphere(r,x,y,z,mat,parent=root) {return mesh(new T.SphereGeometry(r,20,12),mat,[x,y,z],parent);}
  function tube(points,r,mat,parent=root,segments=24) {
    const curve=new T.CatmullRomCurve3(points.map(p=>new T.Vector3(...p)));
    return mesh(new T.TubeGeometry(curve,segments,r,8,false),mat,[0,0,0],parent);
  }
  function rod(a,b,r,mat,parent=root) {
    const start=new T.Vector3(...a),end=new T.Vector3(...b),delta=end.clone().sub(start);
    const o=cylinder(r,r,delta.length(),...start.clone().add(end).multiplyScalar(.5).toArray(),mat,parent,10);
    o.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),delta.normalize());return o;
  }
  function group(name,x=0,y=0,z=0,parent=root) {const g=new T.Group();g.name=name;g.position.set(x,y,z);parent.add(g);features[name]=(features[name]??0)+1;return g;}
  function canvasTexture(width,height,draw){const c=document.createElement('canvas');c.width=width;c.height=height;draw(c.getContext('2d'),width,height);const tx=new T.CanvasTexture(c);tx.colorSpace=T.SRGBColorSpace;tx.anisotropy=4;return tx;}
  function label(text,w,h,x,y,z,{bg='#f4e7c8',fg='#344858',sub='',font=76,lit=false,parent=root}={}){
    const tx=canvasTexture(1024,Math.max(128,Math.round(1024*h/w)),(c,cw,ch)=>{
      c.fillStyle=bg;c.fillRect(0,0,cw,ch);c.strokeStyle=fg;c.lineWidth=4;c.strokeRect(15,15,cw-30,ch-30);
      c.fillStyle=fg;c.textAlign='center';c.textBaseline='middle';c.font=`700 ${Math.min(font,ch*(sub?.54:.63))}px "Yu Gothic",Meiryo,sans-serif`;c.fillText(text,cw/2,ch*(sub?.38:.5),cw-60);
      if(sub){c.font=`500 ${Math.min(font*.32,ch*.17)}px "Yu Gothic",Meiryo,sans-serif`;c.fillText(sub,cw/2,ch*.79,cw-50);}
    });
    const mat=lit?new T.MeshBasicMaterial({map:tx,toneMapped:false}):new T.MeshToonMaterial({map:tx,gradientMap:bands});
    const p=mesh(new T.PlaneGeometry(w,h),mat,[x,y,z],parent);p.castShadow=false;return p;
  }
  function poster(kind,w,h,x,y,z,parent=root){
    const tx=canvasTexture(512,768,(c,cw,ch)=>{
      const orange=kind%2===0;c.fillStyle=orange?'#eee3c9':'#d9eee5';c.fillRect(0,0,cw,ch);
      c.fillStyle=orange?'#b34c41':'#28615c';c.fillRect(0,0,cw,130);c.fillStyle='#fff8dc';c.textAlign='center';c.font='700 58px "Yu Gothic",Meiryo,sans-serif';c.fillText(orange?'ほっと、ひと息':'季節のおいしさ',cw/2,88);
      c.fillStyle=orange?'#634234':'#f8efe0';c.beginPath();c.ellipse(256,365,150,140,0,0,Math.PI*2);c.fill();
      c.fillStyle=orange?'#e6c69b':'#3a5446';c.beginPath();c.ellipse(256,350,120,95,0,0,Math.PI*2);c.fill();
      if(orange){c.strokeStyle='#f8e5c3';c.lineWidth=13;for(let i=0;i<3;i++){c.beginPath();c.moveTo(205+i*50,260);c.bezierCurveTo(170+i*50,220,245+i*50,210,210+i*50,170);c.stroke();}}
      else{c.fillStyle='#f6f0d9';for(let i=0;i<3;i++){c.beginPath();c.moveTo(145+i*105,420);c.lineTo(195+i*105,300);c.lineTo(245+i*105,420);c.fill();}c.fillStyle='#3e554a';c.fillRect(230,376,52,62);}
      c.fillStyle='#394b50';c.font='700 45px "Yu Gothic",Meiryo,sans-serif';c.fillText(orange?'挽きたて珈琲':'手づくり おにぎり',256,575);c.font='700 64px sans-serif';c.fillText(orange?'¥ 120':'¥ 150',256,675);
    });
    return mesh(new T.PlaneGeometry(w,h),new T.MeshBasicMaterial({map:tx,toneMapped:false}),[x,y,z],parent);
  }
  // Merge the static authored meshes by material. Dynamic doors and effects stay separate.
  function batchStatic() {
    root.updateMatrixWorld(true);const batches=new Map(),edges=[],remove=[];
    root.traverse(o=>{
      if(!o.isMesh||o.material.transparent||o.userData.dynamic||o.isReflector)return;
      for(let p=o.parent;p&&p!==root;p=p.parent)if(p.userData.dynamic)return;
      const g=(o.geometry.index?o.geometry.toNonIndexed():o.geometry.clone()).applyMatrix4(o.matrixWorld);const list=batches.get(o.material)??[];list.push(g);batches.set(o.material,list);remove.push(o);
      if(o.geometry.type!=='PlaneGeometry'&&o.geometry.parameters?.width>.38){const e=new T.EdgesGeometry(o.geometry,32);e.applyMatrix4(o.matrixWorld);edges.push(e);}
    });
    for(const o of remove)o.removeFromParent();
    for(const [mat,gs] of batches){const m=mesh(mergeGeometries(gs,false),mat,[0,0,0]);m.name='static-'+mat.uuid;gs.forEach(g=>g.dispose());}
    if(edges.length){const lines=new T.LineSegments(mergeGeometries(edges,false),ink);lines.name='architectural-ink';root.add(lines);edges.forEach(g=>g.dispose());}
    return {authoredMeshes:remove.length,batches:batches.size};
  }
  return {root,features,toon,glow,mesh,box,cylinder,sphere,tube,rod,group,label,poster,canvasTexture,batchStatic};
}
