'use strict';
const fs=require('node:fs'),p=require('node:path'),assert=require('node:assert/strict');
const query=require('node:url');
const source='/src/station.js', batch='/upstream/sakuragaoka/src/core/batch2.js';
function replaceOnce(s,a,b) {assert.equal(s.split(a).length,2,'expected a single '+a);return s.replace(a,b);}
function attach(server,fixture){
 const base=server.listeners('request')[0];server.removeListener('request',base);
 server.on('request',(req,res)=>{
  const name=query.parse(req.url).pathname;
  if(![source,batch].includes(name))return base(req,res);
  let s=fs.readFileSync(p.join(fixture,name.slice(1)),'utf8');
  if(name===source)s=replaceOnce(s,'  const batch = batchStatic',`  const __provenance = new Map();
  const __original=[];
  for(const id of ['plaza','w3']){
    const tree=ctx.staticRoot.getObjectByName('sakura-'+id);
    if(!tree)throw Error('Missing painted tree '+id);
    for(const o of tree.children){
      if(!o.isMesh||!o.userData.role)continue;
      const part=id+'/'+o.userData.role;
      __original.push({part,mesh:o,mat:o.material});
      __provenance.set(o,{sources:[part],totalSources:1});
    }
  }
  if(__original.length!==6)throw Error('Expected six painted roles but found '+__original.length);
  window.__plazaProvenance={byObject:__provenance,original:__original};
  const batch = batchStatic`);
  else s=replaceOnce(s,'    out.add(mesh);',`    const probe=window.__plazaProvenance;
    if(probe){const included=list.flatMap(item=>probe.byObject.get(item.o)?.sources||[]);
      if(included.length)probe.byObject.set(mesh,{sources:included,totalSources:list.length});}
    out.add(mesh);`);
  res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store'}).end(s);
 });
}
module.exports=attach;
