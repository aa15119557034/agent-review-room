import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const out=join(root,".verification");mkdirSync(out,{recursive:true});
const packages=["packages/schemas","packages/core","packages/db","packages/reviewer-client","packages/remote-client","apps/agent-server","apps/desktop"];
const suites=packages.map(p=>[p,p+"/test"]).concat([["renderer","apps/desktop/src/renderer/test"],["e2e","apps/desktop/e2e"]]);
const types=packages.map(p=>[p,p+"/tsconfig.json"]).concat([["renderer","apps/desktop/src/renderer/tsconfig.json"],["e2e","apps/desktop/e2e/tsconfig.json"]]);
const results=[];
async function run(name,args,cwd=root){
 const log=join(out,name.replaceAll("/","-")+".log"),stream=createWriteStream(log),start=Date.now();
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const code=await new Promise(done=>{
  const child=spawn(process.execPath,args,{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream,{end:false});
  child.on("error",e=>{stream.write(e.message);done(-1);});child.on("close",c=>done(c??-1));
 });
 await new Promise(done=>stream.end(done));
 const output=readFileSync(log,"utf8");
 const counts=Object.fromEntries(["tests","pass","fail","cancelled","skipped"].map(k=>[k,Number(output.match(new RegExp("(?:ℹ |# )"+k+" (\\d+)"))?.[1]??0)]));
 const result={name,code,milliseconds:Date.now()-start,log,...counts};results.push(result);
 console.log(JSON.stringify(result));if(code!==0)console.log(output.slice(-8000));
}
const mode=process.argv[2]??"all";
if(!["all","tests","types","build"].includes(mode))throw new Error("Usage: node scripts/verify.mjs [all|tests|types|build]");
if(mode==="all"||mode==="tests")for(const [name,folder]of suites)await run("tests-"+name,[join(root,"node_modules/tsx/dist/cli.mjs"),"--test",...readdirSync(join(root,folder)).filter(f=>f.endsWith(".test.ts")).map(f=>join(root,folder,f))]);
if(mode==="all"||mode==="types")for(const [name,config]of types)await run("types-"+name,[join(root,"node_modules/typescript/bin/tsc"),"-p",join(root,config)]);
if(mode==="all"||mode==="build"){
 await run("build-desktop",["node_modules/electron-vite/bin/electron-vite.js","build"],join(root,"apps/desktop"));
 await run("build-agent-server",["scripts/bundle.mjs"],join(root,"apps/agent-server"));
}
const sha=execFileSync("git",["-c","safe.directory="+root,"rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim();
const summary={sha,dirty:execFileSync("git",["-c","safe.directory="+root,"status","--porcelain"],{cwd:root,encoding:"utf8"}).trim().length>0,node:process.version,mode,results,passed:results.every(r=>r.code===0)};
writeFileSync(join(out,"summary-"+mode+".json"),JSON.stringify(summary,null,2));
if(!summary.passed)process.exitCode=1;
