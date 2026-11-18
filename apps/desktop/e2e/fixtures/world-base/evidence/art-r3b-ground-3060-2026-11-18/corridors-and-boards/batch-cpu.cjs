const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const sha='ffbcfa3e091bdb2d4a7cf94367d40868101c2ddc';
const fixture=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]),basename='upstream/sakuragaoka/src/core/batch2.js';
const baseline=require(path.join(fixture,'scripts/baseline.cjs'));
if(!process.versions.electron){
 const exe=process.argv[4];if(!exe)throw Error('Provide an installed Electron executable as the third argument');
 fs.mkdirSync(out,{recursive:true});
 cp.execFileSync('git',['diff','--quiet',sha,'--','src','upstream/sakuragaoka/src'],{cwd:fixture});
 const proc=cp.spawnSync(exe,[__filename,fixture,out],{env:baseline.cleanEnvironment(path.join(out,'runtime')),cwd:fixture,windowsHide:true,stdio:'inherit',timeout:125000});console.log('Electron exit',proc.status,proc.error?.message||'');process.exit(proc.status??1);
}
const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();
for(const flag of ['disable-gpu','disable-software-rasterizer','disable-webgl','disable-accelerated-2d-canvas','in-process-gpu'])app.commandLine.appendSwitch(flag);
app.setPath('userData',path.join(out,'chromium-userdata'));
async function scan(){
 const T=await import('three'),{createStation}=await import('./src/station.js'),{installToonHook}=await import('./src/toon.js');
 installToonHook();
 const scene=new T.Scene(),camera=new T.PerspectiveCamera(60,1.6,.1,3000),renderer={getDrawingBufferSize:v=>v.set(1440,900)};
 const groundMaterial=new T.ShaderMaterial({fragmentShader:'void main(){vec3 col=vec3(1.0); gl_FragColor = vec4(col, 1.0);}'});
 const station=await createStation({scene,camera,renderer,groundMaterial,evening:true});
 const solo=[],images=globalThis.__audit;
 station.root.traverse(o=>{if(o.isMesh&&/art-r[13]-(board-|w1-zone-|e[12]-board)/.test(o.material?.name||''))solo.push(o.material.name)});
 const a=station.artR1.stats;
 const answer={batch:station.batch,retainedSolo:solo,boards:a.shopBoards,flags:a.nobori,images};
 station.dispose();return answer;
}
function inspectGroup(mesh,list,ordinal){
 const boxes=['W2','W4','W6','E3','E5'];
 const tags=list.filter(it=>it.o.material?.name?.startsWith('art-r3-board-')||it.o.material?.name?.startsWith('art-r3-w1-zone-'));
 for(const it of tags){const m=it.o.material,t=it.tile,o=it.o;
  if(!t)throw Error('Missing actual atlas tile for '+m.name);
  const source=m.map.image, atlas=mesh.material.map.image,w=source.width,h=source.height,x=Math.round(t.u0*atlas.width),y=Math.round((1-t.v0-t.sv)*atlas.height);
  const src=source.getContext('2d').getImageData(0,0,w,h).data,dst=atlas.getContext('2d').getImageData(x,y,w,h).data;
  let pixelsDifferent=0;const colors=new Set();for(let i=0;i<src.length;i+=4){if(src[i]!==dst[i]||src[i+1]!==dst[i+1]||src[i+2]!==dst[i+2]||src[i+3]!==dst[i+3])pixelsDifferent++;colors.add((src[i]<<16)|(src[i+1]<<8)|src[i+2]);}
  const countTri=g=>(g.index?.count??g.attributes.position.count)/3;
  const sourceBoard=o.parent?.parent;let triangles=null,sourceMeshes=null;
  if(m.name.startsWith('art-r3-board-')){triangles=0;sourceMeshes=0;sourceBoard.traverse(s=>{if(s.isMesh){triangles+=countTri(s.geometry);sourceMeshes++;}});}
  const vertexStart=list.slice(0,list.indexOf(it)).reduce((n,a)=>n+a.o.geometry.attributes.position.count,0);
  const uv=o.geometry.attributes.uv, actual=mesh.geometry.attributes.uv,col=mesh.geometry.attributes.color;
  let uvMaxError=0,colorMaxError=0;for(let k=0;k<uv.count;k++){
   uvMaxError=Math.max(uvMaxError,Math.abs(actual.getX(vertexStart+k)-(t.u0+t.su*uv.getX(k))),Math.abs(actual.getY(vertexStart+k)-(t.v0+t.sv*uv.getY(k))));
   colorMaxError=Math.max(colorMaxError,...[0,1,2].map(i=>Math.abs(col.getComponent(vertexStart+k,i)-[m.color.r,m.color.g,m.color.b][i])));
  }
  globalThis.__audit.push({material:m.name,sourceType:m.type,vertexRGB:m.color.toArray(),noBatch:Boolean(o.userData.noBatch),sourceMeshes,triangles,printTriangles:countTri(o.geometry),atlasPage:t.page,pageSize:[atlas.width,atlas.height],tile:[x,y,w,h],pixelsDifferent,distinctRGB:colors.size,outputBatch:ordinal,outputMaterial:mesh.material.type,outputBatchSources:list.length,outputBatchTriangles:countTri(mesh.geometry),uvMaxError,colorMaxError});
 }
}
app.whenReady().then(async()=>{
 const server=baseline.createStaticServer(fixture),handlers=server.listeners('request');server.removeAllListeners('request');
 const index=fs.readFileSync(path.join(fixture,'index.html'),'utf8').match(/<script type="importmap">.*?<\/script>/s)[0];
 const original=fs.readFileSync(path.join(fixture,basename),'utf8'),marker='out.add(mesh);';
 if(original.split(marker).length!==2)throw Error('Unexpected source anchor');
 const instrumented='globalThis.__audit=[];\n'+inspectGroup.toString()+'\n'+original.replace(marker,marker+'\n inspectGroup(mesh,list,merged);');
 server.on('request',(req,res)=>{const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/board-verify.html'){res.writeHead(200,{'Content-Type':'text/html'});return res.end(index)}
 if(pathname==='/'+basename){res.writeHead(200,{'Content-Type':'application/javascript'});return res.end(instrumented)}for(const h of handlers)h(req,res);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
 try{
  await win.loadURL('http://127.0.0.1:'+server.address().port+'/board-verify.html');
  const result=await win.webContents.executeJavaScript('('+scan.toString()+')()');
  if(result.images.length!==8||result.images.some(r=>r.pixelsDifferent||r.uvMaxError>1e-6||r.colorMaxError>1e-6||r.distinctRGB<8)||result.retainedSolo.some(n=>n.startsWith('art-r3-')))throw Error('Material/atlas failed '+JSON.stringify(result));
  fs.writeFileSync(path.join(out,'boards-batch.json'),JSON.stringify({source:sha,CPUOnly:true,features:app.getGPUFeatureStatus(),...result},null,2)+'\n');
  console.log('FULL STATION PASS',result.batch,JSON.stringify(result.images.map(r=>[r.material,r.atlasPage,r.outputBatch,r.pixelsDifferent,r.outputBatchSources])));app.exit(0);
 }catch(e){console.error(e.stack);app.exit(1);}
}).catch(e=>{console.error(e.stack);app.exit(1)});
