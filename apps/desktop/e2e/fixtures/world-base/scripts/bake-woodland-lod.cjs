// Bake four views of each actual mesh to transparent cards for distant stands.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {createStaticServer,cleanEnvironment}=require('./baseline.cjs');
const root=path.join(__dirname,'..');
if (!process.versions.electron){
  const log=fs.openSync(path.join(root,'artifacts/alpine/lod-bake.log'),'w');
  const run=cp.spawnSync(process.argv[2],[__filename],{cwd:root,env:cleanEnvironment(path.join(root,'artifacts/alpine/bake-runtime')),stdio:['ignore',log,log],windowsHide:true,timeout:90000});
  fs.closeSync(log);if(run.status!==0)console.error(fs.readFileSync(path.join(root,'artifacts/alpine/lod-bake.log'),'utf8'));
  process.exit(run.status??1);
}
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(root,'artifacts/alpine/bake-runtime/user-data'));
app.whenReady().then(async()=>{
  const files=createStaticServer(root);
  const server=require('node:http').createServer((req,res)=>req.url==='/bake' ? blank(req,res) : files.emit('request',req,res));
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
  // An empty same-origin document shares the fixture's pinned import map.
  const port=server.address().port;
  function blank(req,res){
    res.writeHead(200,{'Content-Type':'text/html'}).end('<script type="importmap">{"imports":{"three":"/upstream/petalwake/vendor/three/build/three.module.js","three/addons/":"/upstream/petalwake/vendor/three/examples/jsm/"}}</script>');
  }
  await win.loadURL('http://127.0.0.1:'+port+'/bake');
  const png=await win.webContents.executeJavaScript(`(async()=>{
    const T=await import('three'),{loadWoodlandModels}=await import('/src/woodland-models.js');
    const trees=await loadWoodlandModels(),size=256,canvas=document.createElement('canvas');
    canvas.width=size*4;canvas.height=size*trees.length;
    const ctx=canvas.getContext('2d'),scene=new T.Scene(),renderer=new T.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
    renderer.setSize(size,size,false);renderer.setClearColor(0,0);
    scene.add(new T.HemisphereLight(0xffffff,0xd1cfb7,1.95));
    const sky=new T.DirectionalLight(0xffffff,1.05);sky.position.set(-0.4,1,0.55);scene.add(sky);
    for(let i=0;i<trees.length;i++){
      const {tree,height}=trees[i];scene.add(tree);
      const half=height*0.80,cam=new T.OrthographicCamera(-half,half,half,-half,0.1,100);
      for(let j=0;j<4;j++){
        const a=j*Math.PI/2;cam.position.set(40*Math.sin(a),height*0.5,40*Math.cos(a));cam.lookAt(0,height*0.5,0);
        renderer.render(scene,cam);ctx.drawImage(renderer.domElement,size*j,size*i);
      }
      scene.remove(tree);
    }
    return canvas.toDataURL('image/png').split(',')[1];
  })()`);
  fs.writeFileSync(path.join(root,'src/woodland/distant.png'),Buffer.from(png,'base64'));app.exit(0);
}).catch(e=>{console.error(e);app.exit(1)});
