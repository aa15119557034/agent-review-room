import * as THREE from 'three';
import { hedgeGeometry } from '../upstream/sakuragaoka/src/world/lib/foliage.js';

const HEDGE_PAINT_SIZE = 512;
function hedgePaint() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = HEDGE_PAINT_SIZE;
  const g = canvas.getContext('2d'), size = HEDGE_PAINT_SIZE;
  g.fillStyle = '#587451';
  g.fillRect(0, 0, size, size);
  const leaf = (x, y, angle, length, width, color) => {
    g.save();
    g.translate(x, y);
    g.rotate(angle);
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, 0);
    g.bezierCurveTo(length * .25, -width * .62, length * .66, -width * .69, length, 0);
    g.bezierCurveTo(length * .69, width * .65, length * .26, width * .64, 0, 0);
    g.fill();
    g.restore();
  };
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    const seed = col + row * 4;
    const x = (col + .48 + .30 * Math.sin(seed * 2.7)) * size / 4;
    const y = (row + .54 + .29 * Math.sin(seed * 1.9)) * size / 4;
    const tilt = .44 * Math.sin(seed * 3.2);
    // Wrap the edge clusters to keep the repeat invisible at the curved crown.
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      const px = x + ox, py = y + oy;
      if (px < -80 || py < -80 || px > size + 80 || py > size + 80) continue;
      leaf(px - 11, py + 18, 2.70 + tilt, 59, 44, '#4c674a');
      leaf(px - 2, py + 19, .68 + tilt, 65, 43, '#688253');
      leaf(px - 12, py + 7, -2.34 + tilt, 69, 46, '#6e8a5e');
      leaf(px - 4, py + 8, -.45 + tilt, 75, 48, '#799361');
      leaf(px + 3, py + 8, -1.24 + tilt, 67, 40, '#8da36b');
      leaf(px + 4, py + 14, .36 + tilt, 49, 26, '#9aac73');
      leaf(px - 4, py + 5, -2.80 + tilt, 37, 24, '#a7b27a');
    }
  }
  const map = new THREE.CanvasTexture(canvas);
  map.name = 'town-painted-hedge-leaf-groups';
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1 / 1.28, 1 / .86);
  map.anisotropy = 4;
  return map;
}

// Original evergreen sprigs. One cutout atlas and four instanced folded-card pools;
// no transparent sorting, lobe meshes, extra lights or station texture-cache entries.
function leafAtlas() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
  const g = canvas.getContext('2d'); g.clearRect(0, 0, 1024, 1024);
  const palettes = [
    ['#657956', '#779061', '#536b4e'], ['#586f52', '#6c825b', '#4b614b'],
    ['#708357', '#839366', '#5b7353'], ['#637753', '#768959', '#526b4b'],
  ];
  for (let variant = 0; variant < 4; variant++) {
    g.save(); g.translate((variant % 2) * 512, Math.floor(variant / 2) * 512);
    const [mid, light, shade] = palettes[variant];
    g.lineCap = 'round'; g.strokeStyle = shade; g.lineWidth = 8;
    g.beginPath(); g.moveTo(256, 504); g.bezierCurveTo(247, 332, 275, 184, 256, 42); g.stroke();
    const leaf = (x, y, angle, length, width, index) => {
      g.save(); g.translate(x, y); g.rotate(angle);
      g.fillStyle = mid; g.beginPath(); g.moveTo(0, 0);
      g.bezierCurveTo(length * .18, -width * .72, length * .61, -width, length, -.035 * length);
      g.bezierCurveTo(length * .74, width * .57, length * .22, width * .7, 0, 0); g.fill();
      g.fillStyle = shade; g.beginPath(); g.moveTo(length * .05, 0);
      g.quadraticCurveTo(length * .48, width * .04, length * .84, -width * .05);
      g.quadraticCurveTo(length * .50, width * .56, length * .05, 0); g.fill();
      if (index % 2 === 0) {
        g.fillStyle = light; g.beginPath(); g.moveTo(length * .24, -width * .18);
        g.quadraticCurveTo(length * .52, -width * .64, length * .76, -width * .28);
        g.quadraticCurveTo(length * .54, -width * .30, length * .24, -width * .18); g.fill();
      }
      g.restore();
    };
    for (let i = 0; i < 7; i++) {
      const side = i % 2 ? 1 : -1, y = 424 - i * 49;
      const x = 256 + Math.sin((504 - y) / 460 * Math.PI) * 8;
      const length = (variant === 0 ? 145 : 168) - i * 7;
      leaf(x, y, side < 0 ? -2.72 + i * .045 : -.43 - i * .025,
        length, variant === 0 ? 41 : 52 - i * 1.6, i);
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
  const canopyMap = hedgePaint();
  const plain = materials.plain;
  const canopyMaterial = plain.clone();
  canopyMaterial.onBeforeCompile = plain.onBeforeCompile;
  canopyMaterial.customProgramCacheKey = () => plain.customProgramCacheKey() + '|painted-hedge';
  canopyMaterial.userData.wbNoFlat = true;
  canopyMaterial.name = 'town-hedge-painted-canopy';
  canopyMaterial.map = canopyMap;
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
  let active = null, finished = false, branchTriangles = 0, canopyTriangles = 0;
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
    const record = { ...active, bounds: { min: b.min.toArray(), max: b.max.toArray() }, triangles: active.cards * 4 + active.branchTriangles + (active.canopyTriangles ?? 0) };
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
  function addClippedCanopy(x0, x1, z, ground, random) {
    const center = (x0 + x1) / 2, base = ground(center, z);
    const geometry = hedgeGeometry({
      length: x1 - x0 - .12, h: .62, d: .46, spacing: .13,
      colors: { top: '#687e58', mid: '#566d50', base: '#415644' },
      seed: Math.floor(random() * 65536), ground: x => ground(center + x, z) - base, surfaceUV: true,
    });
    const { uv, color } = geometry.attributes;
    for (let i = 0; i < uv.count; i++) {
      uv.setX(i, uv.getX(i) + center * .37 + z * .18);
      // The atlas supplies leaf hues. The baked foliage colours supply only the
      // body shading so two green layers do not multiply into an olive mass.
      const lum = .2126 * color.getX(i) + .7152 * color.getY(i) + .0722 * color.getZ(i);
      const tone = .72 + .28 * THREE.MathUtils.smoothstep(lum, .055, .23);
      color.setXYZ(i, tone, tone, tone);
    }
    const mesh = new THREE.Mesh(geometry, canopyMaterial);
    mesh.name = active.name + '-canopy';
    mesh.position.set(center, base, z);
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    active.canopyTriangles = geometry.index.count / 3;
    canopyTriangles += active.canopyTriangles;

    // Sample by surface area so the visible tips do not trace the canopy's vertex rings.
    const { position } = geometry.attributes;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3(), tip = new THREE.Vector3();
    let sprig = 0;
    for (let i = 0; i < position.count; i++) {
      a.fromBufferAttribute(position, i).add(mesh.position);
      include(a.toArray());
    }
    for (let i = 0; i < geometry.index.count; i += 3) {
      a.fromBufferAttribute(position, geometry.index.getX(i)).add(mesh.position);
      b.fromBufferAttribute(position, geometry.index.getX(i + 1)).add(mesh.position);
      c.fromBufferAttribute(position, geometry.index.getX(i + 2)).add(mesh.position);
      ab.subVectors(b, a); ac.subVectors(c, a); normal.crossVectors(ab, ac);
      const count = Math.floor(normal.length() * .5 * 160 + random());
      normal.normalize();
      for (let j = 0; j < count; j++) {
        const t = Math.sqrt(random()), u = random();
        tip.copy(a).addScaledVector(ab, t * (1 - u)).addScaledVector(ac, t * u);
        if (tip.y < ground(tip.x, tip.z) + .08) continue;
        const direction = [normal.x + .9 * (random() - .5), .55 + normal.y, normal.z + .45 * (random() - .5)];
        const length = .095 + .05 * random();
        const roll = random() * 2 * Math.PI, variant = Math.floor(random() * 3), value = 1 + .32 * random();
        // Gather the existing surface sprigs into leaf clusters across staggered
        // sections of the clipped canopy. Keep the original pose of each sprig.
        const along = (tip.x - center) / .36 + (tip.z < z ? .5 : 0);
        const section = Math.floor(along), dx = (along - section - .5) / .45;
        const middle = base + .35 + .10 * Math.sin(section * 2.4 + z);
        const dy = (tip.y - middle) / .20;
        const stride = dx * dx + dy * dy < 1 ? 2 : 14;
        if (sprig++ % stride === 0) card(tip.toArray(), direction, length, length, roll, variant, value);
      }
    }
  }
  return {
    texture, material, canopyMap, canopyMaterial, records,
    hedge({ name, x0, x1, z, ground, random:r, footprint, canopyRandom }) {
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
      if (canopyRandom) addClippedCanopy(x0, x1, z, ground, canopyRandom);
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
      const texturePixels = 1024 ** 2 + HEDGE_PAINT_SIZE ** 2;
      return { system:'Painted hedge leaf groups and three-tone leaf sprigs; connected woody stems',
        records, plants:records.length, cards, leafTriangles:cards*4, branchTriangles,canopyTriangles,totalTriangles:cards*4+branchTriangles+canopyTriangles,
        leafDrawCalls:draws,shadowDrawCalls:draws,transparentDrawCalls:0,lobeMeshes:0,
        atlas:{width:1024,height:1024,colorSpace:texture.colorSpace,alphaTest:material.alphaTest,mipmaps:true,variants:4},
        ownedTextures:2,newTexturePixels:texturePixels,textureRGBA8WithMipsEstimateBytes:Math.ceil(texturePixels*4*4/3),
        scope:'23 planted groups: ten front hedges, ten rear shrubs, two garden trees and one shop pot; original root locations and protected clearing rectangles retained.',
        limits:'No LOD currently: four instanced cutout draws across this compact town. Visible leaf layering and alpha-shadow cost require GPU inspection.' };
    },
  };
}
