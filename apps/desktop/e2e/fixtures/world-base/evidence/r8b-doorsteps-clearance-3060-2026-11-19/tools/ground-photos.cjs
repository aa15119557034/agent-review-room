'use strict';
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict'),os=require('node:os');
const fixture=p.resolve(process.env.WORLD_FIXTURE),out=process.argv[3];
let body=fs.readFileSync(p.join(__dirname,'plaza-capture.cjs'),'utf8').replaceAll('\r\n','\n');
function edit(a,b){assert.equal(body.split(a).length,2,a);body=body.replace(a,()=>b);}
edit('show:true,autoHideMenuBar:true','show:false,autoHideMenuBar:true');
edit('    const wc=win.webContents;', '    win.showInactive(); const wc=win.webContents;');
edit("app.commandLine.appendSwitch('force-device-scale-factor','1');","app.commandLine.appendSwitch('force-device-scale-factor','1');\n    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');\n    app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');");
edit("report.photos[key]={...photo,file,hashes:frames.map(hash)};","report.photos[key]={...photo,file,hashes:frames.map(hash)};\n      if(name===\"art-c-alley\")report.facadeMaterials=await wc.executeJavaScript(\"(function materialReceipt(){const w=window.worldBase,r=w.renderer,gl=r.getContext(),materialSet=new Set();w.scene.traverse(o=>{for(const m of Array.isArray(o.material)?o.material:[o.material])if(m?.name?.startsWith('apartment-pbr-'))materialSet.add(m)});return [...materialSet].map(m=>{const programs=r.properties.get(m).programs;const sources=[...(programs?.values?.()||[])].map(p=>{const shaders=gl.getAttachedShaders(p.program)||[];const fs=shaders.find(s=>gl.getShaderParameter(s,gl.SHADER_TYPE)===gl.FRAGMENT_SHADER);return fs?gl.getShaderSource(fs):''});return {name:m.name,ao:m.aoMapIntensity,tex:m.map?.image?.width,normal:m.normalMap?.image?.width,arm:m.aoMap?.image?.width,programCount:sources.length,bounce:sources.some(s=>s.includes('wbFacadeBounce')),shadowTint:sources.some(s=>s.includes('shadowTint')||s.includes('wbShadow'))};}).sort((a,b)=>a.name.localeCompare(b.name));})()\");");
if(process.argv[4]==='shadow-off'){edit("(process.argv[3] === 'off'?'/?ground=off':'/')","'/?shadowtint=off'");}
const tmp=fs.mkdtempSync(p.join(os.tmpdir(),'ground-r4-photo-')),script=p.join(tmp,'capture.cjs');
try{fs.writeFileSync(script,body,{flag:'wx'});cp.execFileSync(process.execPath,[script,'on',...process.argv.slice(2)],{cwd:fixture,env:process.env,windowsHide:true,stdio:'inherit'});}
finally{fs.unlinkSync(script);fs.rmdirSync(tmp);}

