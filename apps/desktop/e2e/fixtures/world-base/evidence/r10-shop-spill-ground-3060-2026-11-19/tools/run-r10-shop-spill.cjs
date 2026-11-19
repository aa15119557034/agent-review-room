'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {spawnSync,execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const [electron, fixtureArg, outputArg, candidate, mode] = process.argv.slice(2);
assert(electron && fixtureArg && outputArg && /^[a-f0-9]{40}$/.test(candidate));
const root = __dirname, output = path.resolve(outputArg), fixture = path.resolve(fixtureArg);
const subpath = 'apps/desktop/e2e/fixtures/world-base';
const checkout = path.resolve(fixture, '../../../../..');
assert.equal(path.resolve(checkout, subpath), fixture);
const audit = path.join('D:/codex/2026-11-16/world-implementation/world-request-audit',subpath);

const baseline = '4d94a1f41d17f18628e90e2c3f03914e37a3e471';
const git = (...args) => execFileSync('git', ['-c','safe.directory='+checkout.split(path.sep).join('/'),...args],{cwd:checkout,windowsHide:true});
const sha = b => createHash('sha256').update(b).digest('hex');
assert.equal(git('rev-parse','HEAD').toString().trim(),candidate);
let host = fs.readFileSync(path.join(root,'x51-r8-evidence','plaza-capture.cjs'),'utf8').replaceAll('\r\n','\n');
const edit = (from,to)=>{
  assert.equal(host.split(from).length,2,from);
  host = host.replace(from,()=>to);
};
const start = host.indexOf('function shoot(name)'), end = host.indexOf('async function capture(out)',start);
assert(start !== -1 && end > start);
host=host.slice(0,start)+require('./r10-shop-spill-page.cjs').toString()+'\n\n'+host.slice(end);
edit(host.split('\n').find(line=>line.startsWith('const samples = ')),"const samples = ['probe-84','shop-b','shop-b-edge','laundry-d','shop-warm'];");
edit('show:true,autoHideMenuBar:true','show:false,autoHideMenuBar:true');
edit('    const wc=win.webContents;','    win.showInactive(); const wc=win.webContents;');
edit("app.commandLine.appendSwitch('force-device-scale-factor','1');","app.commandLine.appendSwitch('force-device-scale-factor','1');\n    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');\n    app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');");
edit('[...samples,samples[0]].entries()','samples.entries()');
edit('assert(photo.hidden && photo.buttonActive);','assert(photo.hidden);');
edit("const key=i===samples.length?'return-a':name, file=key+'.png';fs.writeFileSync(path.join(out,file),frames[2]);","const key=name, file=key+'-on.png'; ['off','on','repeat-on'].forEach((label,i)=>fs.writeFileSync(path.join(out,key+'-'+label+'.png'),frames[i]));");
edit("    for(const k of ['eye','quaternion','fov','time','view']) assert.deepEqual(report.photos[samples[0]][k],report.photos['return-a'][k]);",'');
edit('},480000);','},600000);');
new vm.Script(host);
if (mode==='preflight') {
  console.log('Shop spill instrumented host compiles.');
  process.exit(0);
}
fs.mkdirSync(path.dirname(output),{recursive:true});
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'x51-r9-doors-'));
const script = path.join(temp,'capture.cjs');
try {
  fs.writeFileSync(script,host);
  const run = spawnSync(process.execPath,[script,'on',path.resolve(electron),output],{
    cwd:fixture,env:{...process.env,WORLD_FIXTURE:fixture,AUDIT_FIXTURE:audit,TESTED_SOURCE:candidate},stdio:'inherit',windowsHide:true,
  });
  if(run.error)throw run.error;
  if(run.status!==0)throw Error('Door glow capture exited '+run.status+'. See '+output);
  const report = JSON.parse(fs.readFileSync(path.join(output,'report.json'),'utf8'));
  assert.equal(report.source,candidate);
  assert(report.complete&&report.transportAudit.payloadIntegrityClean);
  const old = JSON.parse(fs.readFileSync(path.join(root,'x51-r9-evidence','door-glow','report.json'),'utf8')).photos['far-east'];
  const probe = report.photos['probe-84'];
  for(const k of ['eye','quaternion','fov','time','canvas']) assert.deepEqual(probe[k],old[k]);
  assert.equal(probe.special.door.samples.find(s=>s.side===.4).weight,0);

  for(const [name,photo] of Object.entries(report.photos)){
    assert.deepEqual(photo.eye,photo.view.position);
    assert.equal(photo.special.groupCount,name==='probe-84'?2:1);
    for(const label of ['off','on','repeat-on']){
      const index=['off','on','repeat-on'].indexOf(label);
      assert.equal(sha(fs.readFileSync(path.join(output,name+'-'+label+'.png'))),photo.hashes[index]);
      assert.equal(photo.special.drawStats[label].visible,label!=='off');
      for(const n of photo.special.groups.map(m=>m.name)) {
        const count=photo.special.drawStats[label].submissions[n];
        assert(label==='off'?count===0:count>0);
      }
    }
  }
  const sources = ['houses/house.js'].map(name=>{
    const file='upstream/sakuragaoka/src/world/'+name;
    const expected=sha(git('show',candidate+':'+subpath+'/'+file));
    const old=sha(git('show',baseline+':'+subpath+'/'+file));
    const served=report.transportAudit.served.find(s=>s.path==='/'+file);
    assert(expected!==old && served?.finished && served.status===200 && served.wireSHA256===expected&&served.sha256===expected);
    return {file,baselineSha256:old,candidateSha256:expected,served};
  });
  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({candidate,baseline,sources},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({candidate,output,views:Object.keys(report.photos)}));
} finally {
  fs.unlinkSync(script);
  fs.rmdirSync(temp);
}
