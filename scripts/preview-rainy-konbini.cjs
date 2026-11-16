const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
(async()=>{
 const repo=path.resolve(__dirname,'..'),output=path.resolve(process.argv.find(a=>a.startsWith('--output='))?.slice(9)||path.join(repo,'artifacts/rainy-konbini'));
 const fixture=path.join(repo,'apps/desktop/e2e/fixtures/rainy-konbini');fs.mkdirSync(output,{recursive:true});
 const sources=Object.fromEntries(fs.readdirSync(fixture).filter(x=>/\.(html|js)$/.test(x)).map(x=>[x,crypto.createHash('sha256').update(fs.readFileSync(path.join(fixture,x))).digest('hex')]));
 fs.writeFileSync(path.join(output,'source-manifest.json'),JSON.stringify({head:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),files:sources,capturedAt:new Date().toISOString()},null,2));
 const {build}=await import(pathToFileURL(require.resolve('../apps/desktop/node_modules/vite/dist/node/index.js')).href);
 await build({configFile:false,root:fixture,base:'./',build:{outDir:path.join(output,'viewer'),emptyOutDir:false,chunkSizeWarningLimit:800}});
 if(process.argv.includes('--build-only'))return;
 const electron=process.argv.find(a=>a.startsWith('--electron='))?.slice(11)||require('../apps/desktop/node_modules/electron'),env={};
 for(const name of ['SystemRoot','windir','SystemDrive','PATH','ComSpec','PATHEXT','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE']){const key=Object.keys(process.env).find(x=>x.toLowerCase()===name.toLowerCase());if(key)env[key]=process.env[key];}
 for(const [name,dir] of Object.entries({LOCALAPPDATA:'local',APPDATA:'roaming',USERPROFILE:'profile',TEMP:'temp',TMP:'temp'})){env[name]=path.join(output,'runtime',dir);fs.mkdirSync(env[name],{recursive:true});}
 const stills=process.argv.includes('--stills'),capture=process.argv.includes('--capture')||stills,log=capture?null:fs.openSync(path.join(output,'preview.log'),'a');
 const child=cp.spawn(electron,[path.join(repo,'apps/desktop/e2e/rainy-konbini-preview.cjs'),output,capture?'--capture':'--preview',...(stills?['--stills']:[])],{cwd:repo,env,stdio:capture?'inherit':['ignore',log,log],detached:!capture,windowsHide:false});
 child.on('error',e=>{console.error(e);process.exitCode=1;});
 if(!capture){fs.closeSync(log);fs.writeFileSync(path.join(output,'preview-process.json'),JSON.stringify({pid:child.pid,executable:electron,started:new Date().toISOString()},null,2));console.log('Preview PID '+child.pid);child.unref();return;}
 child.on('exit',code=>process.exitCode=code??1);
})().catch(e=>{console.error(e);process.exitCode=1;});
