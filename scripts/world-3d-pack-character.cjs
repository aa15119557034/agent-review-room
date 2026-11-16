const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const sharp=require('../apps/desktop/node_modules/sharp');
const inputFolder=process.argv.slice(2).find(arg=>!arg.startsWith('--'));
if(!inputFolder)throw new Error('Usage: node scripts/world-3d-pack-character.cjs <extracted Standard folder> [--male]');
const base=path.resolve(inputFolder);
const input=path.join(base,'Base Characters/Godot - UE');const output=path.resolve(__dirname,'../apps/desktop/src/renderer/assets/world');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const male=process.argv.includes('--male');const json=JSON.parse(fs.readFileSync(path.join(input,male?'Superhero_Male_FullBody.gltf':'Superhero_Female_FullBody.gltf'),'utf8'));
 const chunks=[];let size=0;const add=bytes=>{const start=size;const padded=Buffer.alloc(Math.ceil(bytes.length/4)*4);bytes.copy(padded);chunks.push(padded);size+=padded.length;return start;};
 for(const buffer of json.buffers)add(fs.readFileSync(path.join(input,buffer.uri)));
 // The Standard base has eyebrows but no hair. Merge the author's Long style,
 // retaining the same humanoid bones rather than inventing a second skeleton.
 const hairDir=path.join(base,'Hairstyles/Rigged to Head Bone/glTF (Godot -Unreal)');
 const hair=JSON.parse(fs.readFileSync(path.join(hairDir,male?'Hair_SimpleParted.gltf':'Hair_Long.gltf'),'utf8'));const dataOffset=add(fs.readFileSync(path.join(hairDir,hair.buffers[0].uri)));
 const viewOffset=json.bufferViews.length,accessorOffset=json.accessors.length,materialOffset=json.materials.length,textureOffset=json.textures.length,imageOffset=json.images.length,skinOffset=json.skins.length,meshOffset=json.meshes.length;
 json.bufferViews.push(...hair.bufferViews.map(b=>({...b,buffer:0,byteOffset:(b.byteOffset||0)+dataOffset})));
 json.accessors.push(...hair.accessors.map(a=>({...a,bufferView:a.bufferView+viewOffset})));
 for(const img of hair.images){const png=await sharp(path.join(hairDir,img.uri)).resize(1024,1024,{fit:'inside',withoutEnlargement:true}).png().toBuffer();const offset=add(png);json.images.push({bufferView:json.bufferViews.length,mimeType:'image/png'});json.bufferViews.push({buffer:0,byteOffset:offset,byteLength:png.length});}
 json.textures.push(...hair.textures.map(t=>({...t,source:t.source+imageOffset,sampler:0})));
 for(const m of hair.materials){const next=structuredClone(m);for(const obj of [next,next.pbrMetallicRoughness])if(obj)for(const key of Object.keys(obj))if(key.endsWith('Texture'))obj[key].index+=textureOffset;json.materials.push(next);}
 json.skins.push(...hair.skins.map(s=>({...s,inverseBindMatrices:s.inverseBindMatrices+accessorOffset,joints:s.joints.map(j=>{const name=hair.nodes[j].name;const mapped=json.nodes.findIndex(n=>n.name===name);if(mapped<0)throw new Error('Missing hair joint '+name);return mapped;}),skeleton:json.skins[0].skeleton})));
 json.meshes.push(...hair.meshes.map(m=>({...m,primitives:m.primitives.map(p=>({...p,indices:p.indices+accessorOffset,material:p.material+materialOffset,attributes:Object.fromEntries(Object.entries(p.attributes).map(([key,value])=>[key,value+accessorOffset]))}))})));
 for(const n of hair.nodes.filter(n=>n.mesh!==undefined)){const index=json.nodes.length;json.nodes.push({...n,mesh:n.mesh+meshOffset,skin:n.skin+skinOffset});json.scenes[json.scene||0].nodes.push(index);}
 for(const image of json.images){if(!image.uri)continue;const fixes={'T_Eye_Normal_png.png':'T_Eye_Normal.png','T_Hair_1_Normal_png.png':'T_Hair_1_Normal.png'};const file=fixes[image.uri]||image.uri;const png=await sharp(path.join(input,file)).resize(1024,1024,{fit:'inside',withoutEnlargement:true}).png().toBuffer();const offset=add(png);image.bufferView=json.bufferViews.length;json.bufferViews.push({buffer:0,byteOffset:offset,byteLength:png.length});image.mimeType='image/png';delete image.uri;}
 json.buffers=[{byteLength:size}];json.asset.extras={source:'https://quaternius.com/packs/universalbasecharacters.html',license:'CC0-1.0',changes:'Images resized to at most 1024; embedded GLB. Runtime clothing is a derivative skinned shell.'};
 const jsonData=Buffer.from(JSON.stringify(json));const jsonChunk=Buffer.alloc(Math.ceil(jsonData.length/4)*4,0x20);jsonData.copy(jsonChunk);const bin=Buffer.concat(chunks);const header=Buffer.alloc(12);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(12+8+jsonChunk.length+8+bin.length,8);const a=Buffer.alloc(8);a.writeUInt32LE(jsonChunk.length);a.writeUInt32LE(0x4e4f534a,4);const b=Buffer.alloc(8);b.writeUInt32LE(bin.length);b.writeUInt32LE(0x004e4942,4);const final=Buffer.concat([header,a,jsonChunk,b,bin]);const name=male?'player.glb':'character.glb';fs.writeFileSync(path.join(output,name),final);fs.copyFileSync(path.join(base,'License_Standard.txt'),path.join(output,'QUATERNIUS-LICENSE.txt'));
 console.log(name,final.length,'sha256',crypto.createHash('sha256').update(final).digest('hex'));
})();
