import * as THREE from 'three';

// Original evergreen sprigs. One cutout atlas and four instanced folded-card pools;
// no transparent sorting, lobe meshes, extra lights or station texture-cache entries.
function leafAtlas() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
  const g = canvas.getContext('2d'); g.clearRect(0, 0, 1024, 1024);
  const palettes = [
    ['#687b52', '#a0ad7a', '#425d42'], ['#526c49', '#8a9d69', '#344e3c'],
    ['#7c895a', '#bac18d', '#526c49'], ['#65794c', '#a5b57c', '#405d40'],
  ];
  for (let variant = 0; variant < 4; variant++) {
    g.save(); g.translate((variant % 2) * 512, Math.floor(variant / 2) * 512);
    const [mid, light, shade] = palettes[variant];
    g.lineCap = 'round'; g.strokeStyle = '#7d7752'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(256, 504); g.bezierCurveTo(247, 332, 275, 184, 256, 42); g.stroke();
    const leaf = (x, y, angle, length, width, index) => {
      g.save(); g.translate(x, y); g.rotate(angle);
      const fill = g.createLinearGradient(0, -width, length, width * .65);
      fill.addColorStop(0, shade); fill.addColorStop(.42, mid); fill.addColorStop(1, light);
      g.fillStyle = fill; g.beginPath(); g.moveTo(0, 0);
      g.bezierCurveTo(length * .18, -width * .72, length * .61, -width, length, -.035 * length);
      g.bezierCurveTo(length * .74, width * .57, length * .22, width * .7, 0, 0); g.fill();
      // The fine central vein and alternating secondaries follow the blade,
      // instead of putting a noise field over an otherwise featureless card.
      g.strokeStyle = 'rgba(210,219,164,0.48)'; g.lineWidth = 1.65;
      g.beginPath(); g.moveTo(3, 0); g.quadraticCurveTo(length * .5, -width * .1, length * .94, -.035 * length); g.stroke();
      g.lineWidth = .9; g.strokeStyle = 'rgba(195,208,145,0.28)';
      for (let k = 1; k < 6; k++) for (const side of [-1, 1]) {
        const t = k / 7, vx = length * t, vy = -width * .07 * Math.sin(t * Math.PI);
        g.beginPath(); g.moveTo(vx, vy); g.quadraticCurveTo(vx - length * .07, vy + side * width * .28,
          vx - length * .12, vy + side * width * .50 * Math.sin(t * Math.PI)); g.stroke();
      }
      // A few pale edge catches; no opaque outline around the leaf silhouette.
      if (index % 2 === 0) { g.strokeStyle = 'rgba(217,222,177,0.19)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(length * .1, -width * .21); g.quadraticCurveTo(length * .55, -width * .85, length * .94, -width * .14); g.stroke(); }
      g.restore();
    };
    for (let i = 0; i < 7; i++) {
      const side = i % 2 ? 1 : -1, y = 424 - i * 49;
      const x = 256 + Math.sin((504 - y) / 460 * Math.PI) * 8;
      const length = (variant === 0 ? 145 : 168) - i * 7;
      leaf(x, y, side < 0 ? -2.72 + i * .045 : -.43 - i * .025,
        length, variant === 0 ? 32 : 46 - i * 1.6, i);
    }
    leaf(256, 73, -Math.PI / 2, 53, 20, 8);
    if (variant === 3) {
      // Sparse azalea accents are confined to the shrub/pot sprig variant.
      for (const [x, y, radius] of [[179, 219, 14], [325, 127, 11]]) {
        for (let p = 0; p < 5; p++) { const a = p * Math.PI * .4;
          g.fillStyle = p % 2 ? '#cf9b9a' : '#e5bcad'; g.beginPath();
          g.ellipse(x + Math.cos(a) * radius * .55, y + Math.sin(a) * radius * .55, radius * .7, radius * .48, a, 0, Math.PI * 2); g.fill(); }
        g.fillStyle = '#b6a373'; g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill();
      }
    }
    g.restore();
  }
  const texture = new THREE.CanvasTexture(canvas); texture.name = 'town-original-evergreen-sprigs';
  texture.colorSpace = THREE.SRGBColorSpace; texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping; texture.anisotropy = 4;
  return texture;
}

function cardGeometry(variant) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-.5,0,0,.5,0,0,-.5,.5,.07,.5,.5,.07,-.5,1,0,.5,1,0], 3));
  const u0 = ((variant % 2) * 512 + 8) / 1024, u1 = u0 + 496 / 1024;
  const v0 = 1 - (Math.floor(variant / 2) * 512 + 504) / 1024, v1 = v0 + 496 / 1024;
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([u0,v0,u1,v0,u0,(v0+v1)/2,u1,(v0+v1)/2,u0,v1,u1,v1], 2));
  geometry.setIndex([0,1,2,1,3,2,2,3,4,3,5,4]); geometry.computeVertexNormals();
  geometry.computeBoundingBox(); return geometry;
}

export function createTownPlants({ root, frame, materials, gradientMap }) {
  const texture = leafAtlas();
  const material = new THREE.MeshToonMaterial({ color: '#ffffff', map: texture, gradientMap,
    alphaTest: .42, side: THREE.DoubleSide, transparent: false, depthWrite: true });
  material.name = 'town-evergreen-leaf-cards'; material.shadowSide = THREE.DoubleSide;
  // Box-filtered mips thin the cutout's alpha below alphaTest, so far sprigs dissolved
  // into bare twigs (#254 C19). Scale alpha back up by the sampled mip level (8 levels
  // over the 1024 atlas) so coverage stays roughly constant with distance.
  material.onBeforeCompile = (shader) => {
    const needle = '#include <alphatest_fragment>';
    if (!shader.fragmentShader.includes(needle)) throw new Error('Leaf-card shader lacks alphatest chunk');
    shader.fragmentShader = shader.fragmentShader.replace(needle, `{
      vec2 texel = vMapUv * 1024.0;
      float lod = max(0.0, 0.5 * log2(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel)))));
      diffuseColor.a *= 1.0 + lod * 0.3;
    }
    ${needle}`);
  };
  material.customProgramCacheKey = () => 'town-leaf-mip-alpha';
  const pools = Array.from({ length: 4 }, () => []), records = [];
  const temp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let active = null, finished = false, branchTriangles = 0;
  const include = p => active.bounds.expandByPoint(new THREE.Vector3(...p));
  function branch(a, b, radius, tip = radius * .48) {
    const direction = new THREE.Vector3(...b).sub(new THREE.Vector3(...a)), length = direction.length();
    if (!(length > 0)) throw new Error('Town plant branch has no length');
    const q = new THREE.Quaternion().setFromUnitVectors(up, direction.normalize()), e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    const mid = new THREE.Vector3(...a).add(new THREE.Vector3(...b)).multiplyScalar(.5), start = frame.gb.tris;
    frame.cyl(materials.wood, '#8b8069', radius, length, mid.x, mid.y, mid.z,
      { rTop: tip, seg: radius > .045 ? 6 : 5, open: true, rx: e.x, ry: e.y, rz: e.z });
    const tris = frame.gb.tris - start; active.branchTriangles += tris; branchTriangles += tris;
    for (const p of [a, b]) { include(p.map(v => v - radius)); include(p.map(v => v + radius)); }
  }
  function card(point, direction, width, height, roll, variant, value) {
    const q = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(...direction).normalize());
    q.multiply(new THREE.Quaternion().setFromAxisAngle(up, roll));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...point), q, new THREE.Vector3(width, height, height));
    for (const [x,y,z] of [[-.5,0,0],[.5,0,0],[-.5,.5,.07],[.5,.5,.07],[-.5,1,0],[.5,1,0]]) {
      temp.set(x,y,z).applyMatrix4(m); active.bounds.expandByPoint(temp);
    }
    pools[variant].push({ matrix: m, color: new THREE.Color().setRGB(value, value * .99, value * .94) }); active.cards++;
  }
  function begin(name, kind, footprint) {
    if (active || finished) throw new Error('Invalid town plant build lifecycle');
    active = { name, kind, footprint, bounds: new THREE.Box3(), cards: 0, branchTriangles: 0, roots: [] };
  }
  function end() {
    const b = active.bounds, f = active.footprint;
    if (b.min.x < f.minX - 1e-5 || b.max.x > f.maxX + 1e-5 || b.min.z < f.minZ - 1e-5 || b.max.z > f.maxZ + 1e-5)
      throw new Error('Town plant escaped protected footprint: ' + active.name + ' ' + JSON.stringify({ min:b.min.toArray(),max:b.max.toArray(),f }));
    const record = { ...active, bounds: { min: b.min.toArray(), max: b.max.toArray() }, triangles: active.cards * 4 + active.branchTriangles };
    records.push(record); active = null; return record;
  }
  function fan(point, angle, count, r, scale, flower = false, lift = .8) {
    for (let i = 0; i < count; i++) {
      const a = angle + (i - (count - 1) / 2) * .72 + (r() - .5) * .2;
      const variant = flower && i === 0 ? 3 : r() < .16 ? 2 : r() < .55 ? 0 : 1;
      card(point, [Math.cos(a) * .65, lift + r() * .35, Math.sin(a) * .65],
        scale * (.70 + r() * .15), scale, a + r() * 2.5, variant, .80 + r() * .19);
    }
  }
  return {
    texture, material, records,
    hedge({ name, x0, x1, z, ground, random:r, footprint }) {
      begin(name, 'hedge', footprint); const n = Math.max(2, Math.ceil((x1 - x0) / .38));
      for (let i = 0; i < n; i++) {
        const x = x0 + .12 + (x1 - x0 - .24) * (i + .5) / n, y = ground(x, z), h = .44 + r() * .06;
        active.roots.push([x,y,z]); const foot=[x,y-.025,z], crown=[x+(r()-.5)*.045,y+h,z];
        branch(foot,crown,.018,.009);
        for (let j=0;j<4;j++) {
          const a = j*Math.PI*.5 + r()*.25, base=[x,y+h*(.4+j*.13),z];
          const tip=[x+Math.cos(a)*.105,y+h*(.8+j*.04),z+Math.sin(a)*.13];
          branch(base,tip,.008,.0035); fan(tip,a,2,r,.27,false,.8);
        }
      }
      return end();
    },
    shrub({ name, x, y, z, random:r, footprint, scale=1, flowers=true }) {
      begin(name, scale < .5 ? 'potted-shrub' : 'azalea-shrub', footprint); active.roots.push([x,y,z]);
      for (let j=0;j<9;j++) {
        const a=j*2.39996+r()*.25, d=(.32+r()*.17)*scale;
        const base=[x,y-.015,z], middle=[x+Math.cos(a)*d*.5,y+(.19+r()*.08)*scale,z+Math.sin(a)*d*.3];
        const tip=[x+Math.cos(a)*d,y+(.36+r()*.19)*scale,z+Math.sin(a)*d*.55];
        branch(base,middle,.012*scale,.007*scale); branch(middle,tip,.007*scale,.003*scale);
        for(let k=0;k<3;k++){
          const b=a+(k-1)*.85, twig=[tip[0]+Math.cos(b)*.10*scale,tip[1]+(.02+r()*.07)*scale,tip[2]+Math.sin(b)*.06*scale];
          branch(tip,twig,.0035*scale,.0015*scale);fan(twig,b,3,r,.28*scale,flowers&&j%4===0&&k===0,.6);
        }
      }
      return end();
    },
    tree({ name, x, y, z, random:r, footprint }) {
      begin(name,'garden-olive',footprint);active.roots.push([x,y,z]);
      const joints=[[x,y-.035,z],[x+.025,y+.72,z-.025],[x-.035,y+1.46,z+.01],[x+.04,y+2.30,z-.02]];
      for(let j=0;j<3;j++)branch(joints[j],joints[j+1],.078-j*.019,.060-j*.018);
      for(let j=0;j<10;j++){
        const a=j*2.39996+r()*.2, startY=.83+j*.115;
        const start=[x+(j%2?.02:-.015),y+startY,z], reach=.32+r()*.10;
        const fork=[x+Math.cos(a)*reach*.55,y+startY+.27,z+Math.sin(a)*reach*.55];
        const tip=[x+Math.cos(a)*reach,y+startY+.53,z+Math.sin(a)*reach];
        branch(start,fork,.029-j*.0011,.018);branch(fork,tip,.018,.009);
        for(let k=0;k<5;k++){
          const b=a+(k-2)*.48, twig=[tip[0]+Math.cos(b)*.13,tip[1]+.10+r()*.09,tip[2]+Math.sin(b)*.13];
          branch(tip,twig,.007,.0028);fan(twig,b,4,r,.30,false,.6);
        }
      }
      fan(joints[3],0,6,r,.35,false,1.15);
      return end();
    },
    finish() {
      if(active||finished)throw new Error('Town plant finish called twice');finished=true;
      let cards=0,draws=0;
      for(let variant=0;variant<4;variant++){
        const list=pools[variant];if(!list.length)continue;
        const mesh=new THREE.InstancedMesh(cardGeometry(variant),material,list.length);
        mesh.name='town-leaf-sprigs-'+variant;mesh.userData.townPlantCards=true;
        for(let i=0;i<list.length;i++){mesh.setMatrixAt(i,list[i].matrix);mesh.setColorAt(i,list[i].color);}
        mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor.needsUpdate=true;
        mesh.computeBoundingBox();mesh.computeBoundingSphere();mesh.castShadow=true;mesh.receiveShadow=true;
        root.add(mesh);cards+=list.length;draws++;
      }
      return { system:'Original veined leaf sprigs on folded cutout cards; connected woody stems',
        records, plants:records.length, cards, leafTriangles:cards*4, branchTriangles,totalTriangles:cards*4+branchTriangles,
        leafDrawCalls:draws,shadowDrawCalls:draws,transparentDrawCalls:0,lobeMeshes:0,
        atlas:{width:1024,height:1024,colorSpace:texture.colorSpace,alphaTest:material.alphaTest,mipmaps:true,variants:4},
        ownedTextures:1,newTexturePixels:1024*1024,textureRGBA8WithMipsEstimateBytes:Math.ceil(1024*1024*4*4/3),
        scope:'23 planted groups: ten front hedges, ten rear shrubs, two garden trees and one shop pot; original root locations and protected clearing rectangles retained.',
        limits:'No LOD currently: four instanced cutout draws across this compact town. Visible leaf layering and alpha-shadow cost require GPU inspection.' };
    },
  };
}
