// Test-only rendering/performance fixture. Does not operate the user's apps.
const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');const {pathToFileURL}=require('node:url');
(async()=>{
 const output=path.resolve(process.argv[2]||'artifacts/world-3d');fs.mkdirSync(output,{recursive:true});const fixture=path.join(output,'fixture');
 const {build}=await import(pathToFileURL(require.resolve('../apps/desktop/node_modules/vite/dist/node/index.js')).href);
 await build({configFile:false,base:'./',root:path.resolve(__dirname,'../apps/desktop/e2e/fixtures'),build:{outDir:fixture,emptyOutDir:false,rollupOptions:{input:path.resolve(__dirname,'../apps/desktop/e2e/fixtures/world-3d.html')}}});
 const electron=process.argv[3]||require('../apps/desktop/node_modules/electron');const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 cp.execFileSync(electron,[path.resolve(__dirname,'../apps/desktop/e2e/world-3d-render.cjs'),output,path.join(fixture,'world-3d.html'),...process.argv.filter(a=>a==='--low-dpr')],{env,stdio:'inherit',windowsHide:true});
})().catch(e=>{console.error(e);process.exitCode=1;});
