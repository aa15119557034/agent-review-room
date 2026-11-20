// External only; requires root authorization and root visual README before --write.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {createArchive,read,hash,safe}=require('./x51-curation-core.cjs');
const fixture=path.resolve(__dirname,'../world-base/apps/desktop/e2e/fixtures/world-base');
const head='1677ea3167905a180d8b26c48a4b0c0ffece4325';
const views=['service-corner','laundry-details','shop-interior','20-rear-eye','21-front-eye','station-street','street-detail'];
function main(){
 const args=process.argv.slice(2),arg=args.find(s=>s.startsWith('--readme='));
 if(!args.length||args.includes('--help')){console.log('After root authorization: node x51-curate-c13.cjs --write --readme=x51-c13-evidence-readme.md');return;}
 if(args.length!==2||!args.includes('--write')||!arg||!/^[-\w.]+\.md$/.test(arg.slice(9)))throw Error('Require --write and --readme=<handoff-file.md>');
 const A=createArchive({fixture,out:path.join(fixture,'evidence/look-c13-2026-11-17')}),assets=A.pinnedAssets(head),checks=[],outcomes=[];
 A.json(assets,'source-map/pinned-assets.json');A.queue(A.gitFile(head,'prop-assets.json'),'source-map/prop-assets.json',{exactCommit:head});
 const specs=[
  {label:'baseline',directory:'gpu-town-c13',report:'render-report.json',baseline:true,pid:5924,session:95839,exit:1},
  {label:'diagnostic',directory:'gpu-look-c13-v1',report:'look-report.json',pid:30548,session:62458,exit:1,driver:'x51-c13-diagnostic-gpu.cjs'},
 ];
 for(const spec of specs){
  const run=path.join(fixture,'artifacts',spec.directory),r=read(path.join(run,spec.report)),config=read(path.join(run,'run-config.json'));
  if(r.stage!=='complete'||read(path.join(run,'process.json')).pid!==spec.pid)throw Error('Wrong completed process '+spec.directory);
  const source=A.sourceManifest(path.join(run,'source-manifest.json'),head,assets,!!spec.baseline);checks.push({artifact:spec.directory,...source});
  if(config.sourceManifest?.sha256&&config.sourceManifest.sha256!==source.sha256)throw Error('Config/source mismatch');
  for(const name of ['source-manifest.json','run-config.json','process.json'])A.copy(path.join(run,name),spec.label+'/'+name);
  A.gzip(path.join(run,'electron.log'),spec.label+'/electron.log.gz');A.gzip(path.join(run,spec.report),spec.label+'/'+spec.report+'.gz');
  const images=spec.baseline?['01-station-street.jpg','02-station-port.jpg','03-island-aerial.jpg','04-shop-interior.jpg','19-town-rear-stairs.jpg','23-service-corner.jpg','24-laundry-details.jpg','walking-first.jpg','walking-third.jpg']:views.map(v=>v+'-ao-on-capture-2.jpg').concat(['21-front-eye','laundry-details','shop-interior'].map(v=>v+'-ao-on-capture-2.png'));
  if(!spec.baseline){
   if(r.headAfter!==head||r.captures.length!==21||r.shadowFlagCaptures)throw Error('Unexpected C13 diagnostic scope');
   if(r.restoreTargetSha256!==r.restoreStateSha256||r.restoreUnchanged!==true)throw Error('Restore snapshot mismatch');
   A.receipt(read(path.join(run,'prop-assets-manifest.json')),assets);
   if(hash(fs.readFileSync(path.join(__dirname,spec.driver)))!==config.driverSha256)throw Error('Diagnostic driver changed');
   A.copy(path.join(__dirname,spec.driver),spec.label+'/'+spec.driver);
   for(const name of ['prop-assets-manifest.json','density-reference.json','c12-reference.json','city-shadow-audit.json'])A.copy(path.join(run,name),spec.label+'/'+name);
   if(JSON.stringify(read(path.join(run,'city-shadow-audit.json')))!==JSON.stringify(r.cityShadowAudit))throw Error('City readback mismatch');
   const refs=[{name:'density-reference.json',directory:'density-2026-11-17',expectedHead:'0d97731bd7cb4f4634f4c9fdc0e1033ae7585f2a'},{name:'c12-reference.json',directory:'look-c12-2026-11-17'}];
   for(const ref of refs){const meta=read(path.join(run,ref.name)),report=A.gitFile(head,'evidence/'+ref.directory+'/diagnostic/look-report.json.gz'),source=A.gitFile(head,'evidence/'+ref.directory+'/diagnostic/source-manifest.json');if(hash(zlib.gunzipSync(report))!==(meta.reference?.sha256??meta.sha256)||hash(source)!==meta.sourceManifestSha256||(ref.expectedHead&&meta.reference.head!==ref.expectedHead))throw Error('Historical reference mismatch '+ref.name);}
   const expected=new Set(views.flatMap(v=>['warmup','capture-1','capture-2'].map(p=>v+'-ao-on-'+p))),records=[];
   for(const c of r.captures){if(!expected.delete(c.name))throw Error('Unexpected/duplicate capture '+c.name);const files={};for(const ext of ['png','jpg']){const name=safe(c.name+'.'+ext),b=fs.readFileSync(path.join(run,name));files[ext]={filename:name,bytes:b.length,sha256:hash(b),copiedToArchive:images.includes(name)};}if(files.png.sha256!==c.pngSha256)throw Error('PNG changed '+c.name);records.push({name:c.name,view:c.view,pass:c.pass,camera:c.camera,time:c.time,uploadedAO:c.uploadedAO,files});}
   if(expected.size)throw Error('Missing C13 captures');A.json({artifact:spec.directory,records,allCaptureMetadata:spec.report+'.gz',scope:'All 21 frames indexed; seven views, default AO on, warmup plus two captures. No AO-off/HDR/tap/shadow-ABA rerun. Unselected pixels remain in original artifacts.'},spec.label+'/capture-index.json');
  }
  for(const image of images)A.copy(path.join(run,image),spec.label+'/'+image);
  const frames=fs.readdirSync(run).filter(n=>/^frame-samples.*\.json$/.test(n));for(const name of frames)A.copy(path.join(run,name),spec.label+'/'+name);
  const observed={artifact:spec.directory,head,stage:r.stage,ok:r.ok,renderOk:r.renderOk,transportClean:r.transportClean,actualExit:spec.exit,session:spec.session,pid:spec.pid};outcomes.push(observed);
  A.json({...observed,source,networkFailures:r.networkFailures,failedRequestTiming:r.failedRequestTiming,exceptions:r.exceptions,httpErrors:r.httpErrors,failure:r.failure,performance:r.performance,views:r.views?.map(({scene,...view})=>view),walkingValidation:r.walkingValidation,behaviorValidation:r.behaviorValidation,lookValidation:r.lookValidation,firstReady:r.firstReady,initial:r.initial,restore:r.restore,restoreTargetSha256:r.restoreTargetSha256,restoreStateSha256:r.restoreStateSha256,restoreUnchanged:r.restoreUnchanged,sourceUnchanged:r.sourceUnchanged,driverUnchanged:r.driverUnchanged,assetsUnchanged:r.assetsUnchanged,selectedImages:images,frameSamples:frames,scope:spec.baseline?'Normal instrumented baseline, including original failed transport events.':'Fixed-time real assets/materials; no performance or full-navigation claim.'},spec.label+'/measurements.json');
 }
 const cpu=read(path.join(__dirname,'x51-c13-readonly-audit.json'));
 if(cpu.head!==head||cpu.actualExit!==0)throw Error('CPU audit source/result mismatch');
 for(const [file,sha]of Object.entries(cpu.sourceHashes))if(hash(A.gitFile(head,file))!==sha)throw Error('CPU exact source mismatch '+file);
 for(const [file,expected]of Object.entries(cpu.files)){safe(file);const src=path.join(__dirname,file),bytes=fs.readFileSync(src);if(bytes.length!==expected.bytes||hash(bytes)!==expected.sha256)throw Error('CPU artifact changed '+file);if(file.endsWith('.txt'))A.gzip(src,'cpu/'+file+'.gz');else A.copy(src,'cpu/'+file);}
 for(const file of ['x51-c13-readonly-audit.json','x51-c13-readonly-audit.md'])A.copy(path.join(__dirname,file),'cpu/'+file);
 A.json({head,command:cpu.command,actualExit:cpu.actualExit,limits:cpu.limits,scope:'Actual C13 CPU builder evidence with mocked image pixels. No C12/dirty density CPU report substituted as C13 proof. Foundation conclusion covers the identified outside coincident side band, not every internal surface or all moving-camera cases.'},'cpu/scope.json');
 const ci=read(path.join(__dirname,'x51-c13-ci-summary.json'));
 if(ci.head!==head||ci.logSha256!==hash(fs.readFileSync(path.join(__dirname,'x51-c13-ci-log.json'))))throw Error('CI head/log mismatch');
 for(const suffix of ['summary.json','summary.cjs','checks.json','jobs.json'])A.copy(path.join(__dirname,'x51-c13-ci-'+suffix),'ci/x51-c13-ci-'+suffix);
 A.gzip(path.join(__dirname,'x51-c13-ci-log.json'),'ci/job-log.json.gz');
 const visual=read(path.join(__dirname,'x51-c13-visual-readonly.json'));
 if(visual.source!==head||visual.artifactDirectory!=='artifacts/gpu-look-c13-v1')throw Error('Visual review source mismatch');
 for(const entry of visual.images){safe(entry.file);if(!views.some(view=>entry.file===view+'-ao-on-capture-2.jpg'))throw Error('Unexpected visual review image');const bytes=fs.readFileSync(path.join(fixture,visual.artifactDirectory,entry.file));if(bytes.length!==entry.bytes||hash(bytes)!==entry.sha256)throw Error('Visual review image changed');}
 A.copy(path.join(__dirname,'x51-c13-visual-readonly.json'),'analysis/x51-c13-visual-readonly.json');
 const analysis=read(path.join(__dirname,'x51-c13-v1-analysis.json'));
 if(analysis.schema!=='x51-c13-analysis-v1'||analysis.sourceHead!==head||!Array.isArray(analysis.evidenceHashes))throw Error('Wrong frozen C13 analysis');
 for(const [key,spec]of [['normal',specs[0]],['targeted',specs[1]]]){const run=analysis.runs[key];if(run.pid!==spec.pid||run.session!==spec.session||run.actualExit!==spec.exit||path.resolve(run.directory)!==path.resolve(fixture,'artifacts',spec.directory))throw Error('Analysis actual process mismatch '+key);}
 const external=['x51-c13-diagnostic-gpu.cjs','x51-c13-offline-analysis.cjs','x51-c13-v1-numeric.json'];
 const roots=specs.map(s=>fs.realpathSync(path.join(fixture,'artifacts',s.directory)));
 const required=external.map(f=>path.join(__dirname,f)).concat(specs.flatMap(s=>[s.report,'source-manifest.json'].map(f=>path.join(fixture,'artifacts',s.directory,f))),[path.join(fixture,'artifacts/gpu-look-c13-v1/prop-assets-manifest.json')]);
 const paths=new Set(analysis.evidenceHashes.map(e=>path.resolve(e.path)));
 if(paths.size!==analysis.evidenceHashes.length)throw Error('Duplicate analysis evidence path');
 for(const file of required)if(!paths.has(path.resolve(file)))throw Error('Missing analysis input hash '+file);
 for(const entry of analysis.evidenceHashes){const real=fs.realpathSync(entry.path),inside=roots.some(root=>{const r=path.relative(root,real);return r!==''&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);});if(!inside&&!external.includes(path.relative(__dirname,real)))throw Error('Unexpected analysis input path');if(hash(fs.readFileSync(real))!==entry.sha256)throw Error('Analysis input changed '+entry.path);}
 for(const file of ['x51-c13-v1-analysis.json','x51-c13-v1-analysis.md','x51-c13-v1-numeric.json','x51-c13-offline-analysis.cjs'])A.copy(path.join(__dirname,file),'analysis/'+file);
 const references=['evidence/density-2026-11-17/README.md','evidence/density-2026-11-17/diagnostic/look-report.json.gz','evidence/look-c12-2026-11-17/README.md','evidence/look-c12-2026-11-17/diagnostic/look-report.json.gz'];
 A.json(references.map(file=>({file:'../'+file.slice('evidence/'.length),presentInCommit:head,sha256:hash(A.gitFile(head,file)),copied:false})),'prior-references.json');
 A.copy(__filename,'curate-c13.cjs');A.copy(path.join(__dirname,'x51-curation-core.cjs'),'x51-curation-core.cjs');A.copy(path.join(__dirname,'x51-verify-evidence.cjs'),'verify-evidence.cjs');
 A.copy(path.join(__dirname,arg.slice(9)),'README.md');A.queue(Buffer.from('*.gz binary\n*.png binary\n*.jpg binary\n*.json -text\n*.cjs -text\n*.mjs -text\n*.md -text\n'),'.gitattributes');
 A.json({createdAt:new Date().toISOString(),head,checks,outcomes,ci,scope:'Exact Git source, nine original assets, baseline embedded and diagnostic separate receipts verified independently. Original reports/logs lossless gzip, all 21 frames indexed, selected images unchanged. Actual process exits retained; no retry to select green transport. CPU/image judgments remain explicitly scoped. No GPU, scene or GitHub write performed by curator.'},'summary.json');
 console.log(JSON.stringify(A.finish(head),null,2));
}
if(require.main===module){try{main();}catch(error){console.error(error);process.exitCode=1;}}
