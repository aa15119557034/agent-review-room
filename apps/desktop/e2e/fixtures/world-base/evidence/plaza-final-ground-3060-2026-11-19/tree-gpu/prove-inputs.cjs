'use strict';
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),a=require('node:assert/strict');
const inspect=async(tree,source,expectedPin)=>{
 const pathInRepo='apps/desktop/e2e/fixtures/world-base/',fixture=p.join(tree,pathInRepo);const server=require(p.join(fixture,'scripts/baseline.cjs')).createStaticServer(fixture);
 const hash=b=>crypto.createHash('sha256').update(b).digest('hex');const head=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:tree,encoding:'utf8'}).trim();
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
 try{
  const pin=fs.readFileSync(p.join(fixture,'assets/station-art/station-art.sha256'),'utf8').trim().split(/\s+/)[0];a.equal(pin,expectedPin);
  const routes=['src/main.js','src/station.js','src/mature-sakura.js','src/weathering-decals.json','src/street-env/nz.png','src/street-env-evening/nz.png','upstream/sakuragaoka/src/world/sakura.js','upstream/sakuragaoka/src/world/sakura/materials.js','upstream/sakuragaoka/src/core/batch2.js','mature-sakura/mature-sakura.glb'];
  const rows=[];for(const f of routes){
   const http=await fetch('http://127.0.0.1:'+server.address().port+'/'+f);a.equal(http.status,200,f);const bytes=Buffer.from(await http.arrayBuffer());const expected=f.startsWith('mature-sakura/')?fs.readFileSync(p.join(fixture,'.local/station-art-releases',pin,'.local',f)):cp.execFileSync('git',['show',source+':'+pathInRepo+f],{cwd:tree,maxBuffer:16*1024*1024});let match=bytes.equals(expected);
   if(!match&&f.endsWith('.js'))match=expected.toString('utf8').replaceAll('\r\n','\n')===bytes.toString('utf8').replaceAll('\r\n','\n');
   a(match,'wrong version at '+f);rows.push({route:f,bytes:bytes.length,sha256:hash(bytes),expectedSHA256:hash(expected),match:bytes.equals(expected)?'bytes':'normalized-source-text'});
  }
  return {source,observedHead:head,zipSHA256:pin,routes:rows};
 }finally{server.closeAllConnections();server.close();}
};
(async()=>{const [v2,final,out]=process.argv.slice(2);const versions={v2:await inspect(v2,'eed4fb46eb7e78418fa319f6f24bdbfe654425a0','3ef6196ee62ad3b1bf9cfda4ea0feac017ccb64aac208ef4b8b82df0f7ea9d13'),final:await inspect(final,'1ea97233815bedc700751a04fe69ee7fb28b7a21','e4ed22eacde7fc320637468a794fcd99d01c0344a0458adcc214d6c78bd7b54d')};fs.writeFileSync(out,JSON.stringify(versions,null,2)+'\n');})();
