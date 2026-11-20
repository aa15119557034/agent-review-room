'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const [profile,electron,output,mode]=process.argv.slice(2);
if(!['afternoon','evening'].includes(profile)||!electron||!output||!process.env.AUDIT_FIXTURE)throw Error('Set AUDIT_FIXTURE. Pass afternoon|evening, Electron and an unused output path. Use --prepare-only to skip rendering.');
const fixture=path.resolve(process.env.WORLD_FIXTURE || path.join(__dirname,'../../..')),diagnostics=path.resolve(process.env.AUDIT_FIXTURE,'scripts');
const driverFile=path.resolve(output)+'.capture.cjs';
const local=name=>JSON.stringify(path.join(fixture,'scripts',name));
const audit=name=>JSON.stringify(path.join(diagnostics,name));
let src=fs.readFileSync(path.join(diagnostics,'bake-street-reflections.cjs'),'utf8');
function replace(search,sub){assert.equal(src.split(search).length,2,'Existing bake anchor '+search);src=src.replace(search,()=>sub);}
replace("const fixture = path.resolve(__dirname, '..');","const fixture = "+JSON.stringify(fixture)+";");
for(const name of ['diagnose-surface.cjs','diagnose-wet-road.cjs','prepare-props.cjs'])replace("require('./"+name+"')","require("+local(name)+")");
replace("require('./baseline.cjs')","require("+audit('baseline.cjs')+")");
replace("require(path.join(config.fixture, 'scripts/acceptance-transport.cjs'))","require("+audit('acceptance-transport.cjs')+")");
replace("await win.loadURL('http://127.0.0.1:' + server.address().port + '/');","await win.loadURL('http://127.0.0.1:' + server.address().port + "+JSON.stringify(profile==='evening'?'/':'/?time=afternoon')+");");
const consumer=fs.readFileSync(path.join(__dirname,'reflection-use.js'),'utf8');
replace("stage('preparing');","report.requestedProfile="+JSON.stringify(profile)+"; report.reflectionUse=await evaluate("+JSON.stringify(consumer)+"); if(report.reflectionUse.timeOfDay!==report.requestedProfile)throw Error('Different profile'); stage('preparing');");
fs.writeFileSync(driverFile,src,{flag:'wx'});
cp.execFileSync(process.execPath,['--check',driverFile],{stdio:'inherit'});
if(mode!=='--prepare-only'){const run=cp.spawnSync(process.execPath,[driverFile,'--electron='+path.resolve(electron),'--output='+path.resolve(output),'--audit-transport'],{cwd:fixture,stdio:'inherit',windowsHide:true});if(run.error)throw run.error;process.exitCode=run.status??1;}
