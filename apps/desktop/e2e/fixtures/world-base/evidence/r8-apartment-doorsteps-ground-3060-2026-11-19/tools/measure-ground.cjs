'use strict';
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const [before,after,audit,el,tag='r6-native-1119']=process.argv.slice(2);
const d=__dirname,src=JSON.parse(fs.readFileSync(p.join(d,'sources.json'))),records=[];
const sequence=[['photos','before'],['photos','after'],['timing','before'],['timing','after'],['timing','after'],['timing','before'],['legacy','before'],['legacy','after']];
for(const [i,[test,arm]] of sequence.entries()) {
  const fixture=arm==='before'?before:after,sha=arm==='before'?src.base:src.after,id=tag+'-'+i+'-'+arm;
  assert.equal(cp.execFileSync('git',['-c','safe.directory='+p.resolve(fixture,'../../../../..').split(p.sep).join('/'),...['rev-parse','HEAD']],{cwd:fixture,encoding:'utf8',windowsHide:true}).trim(),sha);
  const out=p.join(d,test+'-'+arm),args=test==='photos'?[p.join(d,'ground-photos.cjs'),el,out,'on']:test==='timing'?[p.join(d,'timing-eight.cjs'),el,id]:[p.join(d,'legacy-sixth.cjs'),el,fixture,audit,sha,out];
  const log=p.join(d,id+'.log'),fd=fs.openSync(log,'wx');const record={i,test,arm,fixture,sha,id,started:new Date().toISOString()};records.push(record);
  const save=()=>fs.writeFileSync(p.join(d,'running-state.json'),JSON.stringify(records,null,2)+'\n');
  save();const result=cp.spawnSync(process.execPath,args,{cwd:fixture,env:{...process.env,WORLD_FIXTURE:fixture,AUDIT_FIXTURE:audit,TESTED_SOURCE:sha},windowsHide:true,stdio:['ignore',fd,fd]});
  fs.closeSync(fd);record.status=result.status;record.ended=new Date().toISOString();save();
  if(result.error||result.status!==0)throw Error(test+' '+arm+' '+fs.readFileSync(log,'utf8').slice(-1000));
}
console.log(records.map(r=>[r.test,r.arm,r.status]));
