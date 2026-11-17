// External C17 evidence curator. Never starts a renderer or changes scene sources.
const fs=require('node:fs'),path=require('node:path');
const {createArchive,read,hash,safe}=require('./x51-curation-core.cjs');
const fixture=path.resolve(__dirname,'../world-base/apps/desktop/e2e/fixtures/world-base');
const configFile=path.join(__dirname,'x51-c17-curation-config.json');
const full=name=>path.resolve(__dirname,name);
function metadata(file){const b=fs.readFileSync(file);return{bytes:b.length,sha256:hash(b)};}
function checkFile(file,e){const v=metadata(file);if(!e||v.sha256!==e.sha256||(e.bytes!==undefined&&v.bytes!==e.bytes))throw Error('Frozen input mismatch '+file);return v;}
function main(){
 const args=process.argv.slice(2),c=read(configFile);
 if(!args.length||args.includes('--plan')||args.includes('--help')){console.log(JSON.stringify({config:configFile,output:c.output,pending:c.pending,runs:c.runs,cpu:c.cpu,scope:'Preparation only. --write requires root authorization and all real inputs frozen; no source edits or GPU.'},null,2));return;}
 const rd=args.find(a=>a.startsWith('--readme='));
 if(args.length!==2||!args.includes('--write')||!rd||!/^[-\w.]+\.md$/.test(rd.slice(9)))throw Error('Require --write --readme=<root-handoff.md>');
 if(c.schema!=='x51-c17-curation-config-v1'||c.pending.length||!c.readme||rd.slice(9)!==c.readme.file||!c.analysis?.validationModule)throw Error('Actual C17 inputs/README not frozen');
 const A=createArchive({fixture,out:path.join(fixture,safe(c.output))}),assets=A.pinnedAssets(c.head),sources=[];
 checkFile(full(c.readme.file),c.readme);
 A.json(assets,'source-map/pinned-assets.json');A.queue(A.gitFile(c.head,'prop-assets.json'),'source-map/prop-assets.json',{exactCommit:c.head});
 function put(file,name){if(/\.(?:log|txt|mjs)$/.test(file)||/-log\.json$/.test(file)||fs.statSync(file).size>200000)A.gzip(file,name+'.gz');else A.copy(file,name);}
 function external(name,dest){safe(name);checkFile(full(name),c.frozenFiles[name]);put(full(name),dest+'/'+name);}
 function exact(label,entries){for(const [file,sha256]of entries){safe(file);const b=A.gitFile(c.head,file);if(hash(b)!==sha256)throw Error('CPU exact source mismatch '+label+'/'+file);sources.push({case:label,file,sha256,verifiedCommit:c.head});}}
 const lifecycle=read(full('x51-c17-meadow-lifecycle.json')),lifeProv=read(full('x51-c17-meadow-lifecycle-provenance.json'));
 if(lifeProv.sourceHead!==c.head||lifeProv.actualExitCode!==0)throw Error('Lifecycle execution scope');
 if(lifecycle.sourceHead!==c.head||lifecycle.ok!==true||lifecycle.checks.length!==15||lifecycle.checks.some(e=>e.passed!==true))throw Error('Frozen C17 CPU assertion result mismatch');
 for(const f of lifeProv.files)checkFile(full(safe(f.name)),f);
 exact('lifecycle CPU (partial island insertion fixture)',Object.entries(lifecycle.sourceHashes));
 const ground=read(full('x51-c17-ground-chain-readonly.json'));
 if(ground.head!==c.head)throw Error('Ground chain audit head');
 exact('ground-chain static',ground.sourceHashes.map(e=>[path.relative(fixture,e.path).replaceAll('\\','/'),e.sha256]));
 const priorBase='evidence/greenery-c16-2026-11-18/';
 const oldSeam=JSON.parse(A.gitFile(c.head,priorBase+'cpu/x51-c16-north-seam-views-audit.json'));
 const oldCandidate=A.gitFile(c.head,priorBase+'cpu/x51-c16-north-seam-views.json');
 if(oldSeam.head!==c.historicalSeamHead)throw Error('Historical seam source head');
 exact('C16 seam geometry sources unchanged at C17',oldSeam.sourceHashes.map(e=>[path.relative(fixture,e.path).replaceAll('\\','/'),e.sha256]));
 A.json({originalHead:oldSeam.head,currentHead:c.head,candidateSha256:hash(oldCandidate),candidateReference:'../greenery-c16-2026-11-18/cpu/x51-c16-north-seam-views.json',auditReference:'../greenery-c16-2026-11-18/cpu/x51-c16-north-seam-views-audit.json',scope:'Inherited C16 candidate selection; no C17 selection CPU rerun. Referenced terrain/transition/layout/levee/island source bytes checked unchanged. Original files not duplicated.'},'source-map/inherited-seam-candidates.json');
 for(const name of c.cpu)external(name,'cpu');
 A.json({head:c.head,records:sources,scope:'Exact source byte comparison only. Lifecycle uses actual Meadow/Shell with non-meadow insertion fixtures, not complete scene. Seam candidate CPU belongs to C16 and is referenced separately. No CPU report claims GPU compilation or whole-scene acceptance.'},'source-map/cpu-sources.json');
 const outcomes=[];
 for(const spec of c.runs){
  const dir=path.join(fixture,'artifacts',safe(spec.directory)),r=read(path.join(dir,spec.report)),rc=read(path.join(dir,'run-config.json')),proc=read(path.join(dir,'process.json'));
  if(r.stage!=='complete'||proc.pid!==spec.pid||!Number.isInteger(spec.session)||!Number.isInteger(spec.exit))throw Error('Actual process mismatch '+spec.directory);
  const source=A.sourceManifest(path.join(dir,'source-manifest.json'),c.head,assets,spec.baseline);
  if(rc.sourceManifest?.sha256&&rc.sourceManifest.sha256!==source.sha256)throw Error('Run manifest hash mismatch');
  for(const n of ['source-manifest.json','run-config.json','process.json'])A.copy(path.join(dir,n),spec.label+'/'+n);
  A.gzip(path.join(dir,spec.report),spec.label+'/'+spec.report+'.gz');A.gzip(path.join(dir,'electron.log'),spec.label+'/electron.log.gz');
  if(spec.baseline){
   const receipt=read(full(spec.execution));
   if(receipt.sourceHead!==c.head||receipt.pid!==spec.pid||receipt.session!==spec.session||receipt.actualExit!==spec.exit)throw Error('Normal post-execution receipt mismatch');
   for(const e of receipt.evidenceHashes)checkFile(e.path,e);
   for(const n of [spec.execution,'x51-c17-normal-stdout.txt','x51-c17-normal-stderr.txt'])external(n,spec.label);
  }else{
   A.receipt(read(path.join(dir,'prop-assets-manifest.json')),assets);A.copy(path.join(dir,'prop-assets-manifest.json'),spec.label+'/prop-assets-manifest.json');
   if(!spec.captureArrays||!spec.expectedCaptureNames||!spec.validationModule)throw Error('Actual diagnostic schema not configured');
   if(hash(fs.readFileSync(full(spec.driver)))!==rc.driverSha256)throw Error('Diagnostic driver hash mismatch');
   external(spec.driver,spec.label);
   require(full(safe(spec.validationModule)))({A,c,spec,r,dir,rc,checkFile,external});
   external(spec.validationModule,'analysis');
   const expected=new Set(spec.expectedCaptureNames),records=[];
   for(const key of spec.captureArrays){if(!Array.isArray(r[key]))throw Error('Missing capture array '+key);for(const capture of r[key]){
    if(!expected.delete(capture.name))throw Error('Unexpected/duplicate capture '+capture.name);
    const files={};for(const ext of ['png','jpg']){const n=safe(capture.name+'.'+ext);files[ext]={file:n,...metadata(path.join(dir,n)),copied:spec.images.includes(n)};}
    if(files.png.sha256!==capture.pngSha256)throw Error('Original PNG hash mismatch '+capture.name);
    records.push({array:key,...capture,files});
   }}
   if(expected.size)throw Error('Missing captures');A.json({artifact:spec.directory,records,scope:'Complete original capture metadata/index. Selected images copied without modification; unselected originals remain in artifact.'},spec.label+'/capture-index.json');
   for(const n of spec.readbacks||[])put(path.join(dir,safe(n)),spec.label+'/'+n);
   // Full actual GL shader text must be in these original files, not substituted with only SHA entries.
   if(!spec.fullShaderFiles?.length)throw Error('Full GPU shader source capture missing');
   for(const n of spec.fullShaderFiles)A.gzip(path.join(dir,safe(n)),spec.label+'/'+n+'.gz');
  }
  for(const n of spec.images)A.copy(path.join(dir,safe(n)),spec.label+'/'+n);
  const frames=fs.readdirSync(dir).filter(n=>/^frame-samples.*\.json$/.test(n));for(const n of frames)A.copy(path.join(dir,n),spec.label+'/'+n);
  const outcome={artifact:spec.directory,head:c.head,session:spec.session,pid:spec.pid,actualExit:spec.exit,stage:r.stage,renderOk:r.renderOk,transportClean:r.transportClean,source};outcomes.push(outcome);
  A.json({...outcome,networkFailures:r.networkFailures,exceptions:r.exceptions,httpErrors:r.httpErrors,failure:r.failure,performance:r.performance,views:r.views?.map(({scene,...v})=>v),walkingValidation:r.walkingValidation,behaviorValidation:r.behaviorValidation,lookValidation:r.lookValidation,restoreUnchanged:r.restoreUnchanged,sourceUnchanged:r.sourceUnchanged,assetsUnchanged:r.assetsUnchanged,driverUnchanged:r.driverUnchanged,selectedImages:spec.images,frameSamples:frames},spec.label+'/measurements.json');
 }
 const ci=read(full(c.ciPrefix+'summary.json')),ciProv=read(full(c.ciPrefix+'provenance.json'));
 if(ci.head!==c.head||ciProv.head!==c.head||JSON.stringify(ci.actualCheckout)!==JSON.stringify(ciProv.actualCheckout))throw Error('CI API-head/actual-checkout scope mismatch');
 if(ci.tests!==1615||ci.passed!==1615||ci.types!==9||ci.builds!==2||ci.rows.length!==20||ci.rows.some(row=>row.code!==0))throw Error('C17 actual CI summary contract changed');
 for(const e of ciProv.files){checkFile(e.path,e);external(path.basename(e.path),'ci');}
 external(c.ciPrefix+'provenance.json','ci');
 // put() retains the actual CI job-log JSON as lossless gzip regardless of size.
 const analysisSummary=require(full(safe(c.analysis.validationModule)))({A,c,fixture,checkFile,external});
 external(c.analysis.validationModule,'analysis');
 for(const n of ['x51-curate-c17.cjs','x51-curation-core.cjs','x51-verify-evidence.cjs'])A.copy(full(n),n);
 A.copy(configFile,'curation-config.json');A.copy(full(c.readme.file),'README.md');
 A.queue(Buffer.from('*.gz binary\n*.png binary\n*.jpg binary\n*.json -text\n*.cjs -text\n*.mjs -text\n*.md -text\n'),'.gitattributes');
 A.json({head:c.head,outcomes,ci,analysisSummary,scope:'Original failures and actual exits retained. Initial long frames recorded without causal assignment to meadow wrapper. Source manifests exact Git bytes; nine ignored assets fixed size/MD5/SHA. No original assets/cache/user profile copied.'},'summary.json');
 console.log(JSON.stringify(A.finish(c.head),null,2));
}
if(require.main===module){try{main();}catch(e){console.error(e);process.exitCode=1;}}
