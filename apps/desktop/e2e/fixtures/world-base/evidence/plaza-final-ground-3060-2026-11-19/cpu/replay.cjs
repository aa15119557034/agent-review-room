'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const args=process.argv.slice(2);assert.equal(args.length,3,'node replay.cjs <fixture> <electron> <new output directory>');
const [fixture,electron,out]=args.map(v=>path.resolve(v));fs.mkdirSync(out);
function run(script,argv){cp.execFileSync(process.execPath,[script,...argv],{cwd:fixture,env:{...process.env,WORLD_FIXTURE:fixture},stdio:'inherit',windowsHide:true});}
run(path.join(__dirname,'replay/probe-cpu.cjs'),[electron,path.join(out,'geometry.json')]);
run(path.join(fixture,'evidence/station-art-r3b-ground-3060-2026-11-19/w1/w1-probe.cjs'),['--fixture='+fixture,'--electron='+electron,'--output='+path.join(out,'w1')]);
const corridorDir=path.join(out,'corridors');fs.mkdirSync(corridorDir);
run(path.join(__dirname,'replay/corridors.cjs'),[fixture,corridorDir]);
