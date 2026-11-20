'use strict';
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict'),os=require('node:os');
const fixture=p.resolve(process.env.WORLD_FIXTURE),out=process.argv[3];
let body=fs.readFileSync(p.join(fixture,'evidence/plaza-final-ground-3060-2026-11-19/tools/capture.cjs'),'utf8').replaceAll('\r\n','\n');
function edit(a,b){assert.equal(body.split(a).length,2,a);body=body.replace(a,()=>b);}
edit('show:true,autoHideMenuBar:true','show:false,autoHideMenuBar:true');
edit('    const wc=win.webContents;', '    win.showInactive(); const wc=win.webContents;');
const mark='report.photos[key]={...photo,file,hashes:frames.map(hash)};';
edit(mark,mark+'\n      {const depth=await wc.executeJavaScript('+JSON.stringify('('+require('./read-depth.cjs').toString()+')()')+');const map=Buffer.from(depth.map,"base64");assert.equal(map.length,1440*900);report.photos[key].depthBands={counts:depth.bins,sha256:hash(map),width:1440,height:900};fs.writeFileSync(path.join(out,key+".distance.gz"),require("node:zlib").gzipSync(map));}');
const tmp=fs.mkdtempSync(p.join(os.tmpdir(),'ground-r4-photo-')),script=p.join(tmp,'capture.cjs');
try{fs.writeFileSync(script,body,{flag:'wx'});cp.execFileSync(process.execPath,[script,'on',...process.argv.slice(2)],{cwd:fixture,env:process.env,windowsHide:true,stdio:'inherit'});}
finally{fs.unlinkSync(script);fs.rmdirSync(tmp);}
