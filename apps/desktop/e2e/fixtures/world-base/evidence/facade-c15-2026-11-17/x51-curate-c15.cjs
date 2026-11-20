// External preparation only. No scene execution; --write requires root authorization.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {createArchive,read,hash,safe}=require('./x51-curation-core.cjs');
const fixture=path.resolve(__dirname,'../world-base/apps/desktop/e2e/fixtures/world-base');
const configFile=path.join(__dirname,'x51-c15-curation-config.json');
const views=['service-corner','laundry-details','shop-interior','20-rear-eye','21-front-eye','station-street','street-detail'];
const SERVICE=['x51-p2-service-cpu.mjs','x51-p2-service-cpu-result.json','x51-p2-service-cpu-stderr.txt','x51-p2-service-cpu-final.json','x51-p2-service-cpu-final-stderr.txt'];
function fileMeta(file){const bytes=fs.readFileSync(file);return {bytes:bytes.length,sha256:hash(bytes)};}
function freezeInputs(){
 const hidden=read(path.join(__dirname,'x51-c15-hidden-audit.json')),facade=read(path.join(__dirname,'x51-c15-facade-audit.json'));
 return {hidden:[...hidden.artifacts.map(e=>e.name),'x51-c15-hidden-audit.json','x51-c15-hidden-audit.md'],
  facade:[...Object.keys(facade.files),'x51-c15-facade-audit.json'],service:SERVICE};
}
function main(){
 const args=process.argv.slice(2),config=read(configFile),input=freezeInputs();
 if(!args.length||args.includes('--help')||args.includes('--plan')){console.log(JSON.stringify({externalOnly:true,config:configFile,destination:config.output,pending:config.pending,cpuFiles:input,plannedGpu:{baseline:'4 fixed views, 19 rear stairs, 23/24 details, two walking JPG; raw frame samples and full gzip report/log',diagnostic:'7 default-AO capture-2 JPG plus 21/laundry/shop PNG; all21 capture index and full gzip report/log; actual extra readbacks pending'}},null,2));return;}
 const rd=args.find(x=>x.startsWith('--readme='));
 if(args.length!==2||!args.includes('--write')||!rd||!/^[-\w.]+\.md$/.test(rd.slice(9)))throw Error('Require --write --readme=<root-handoff.md>');
 if(config.schema!=='x51-c15-curation-config-v1'||!/^[a-f0-9]{40}$/.test(config.head||'')||config.pending.length||config.runs.length!==2||!config.analysis||config.serviceActualExit===null)throw Error('C15 inputs not frozen: fill config from actual evidence before archiving');
 const head=config.head,A=createArchive({fixture,out:path.join(fixture,safe(config.output))});
 const sourceMap=[],assets=A.pinnedAssets(head);A.json(assets,'source-map/pinned-assets.json');A.queue(A.gitFile(head,'prop-assets.json'),'source-map/prop-assets.json',{exactCommit:head});
 function copyEvidence(src,name){const size=fs.statSync(src).size;if(/\.(txt|log|mjs)$/.test(src)||(src.endsWith('.json')&&size>200000))A.gzip(src,name+'.gz');else A.copy(src,name);}
 function verifyFile(name,expected){safe(name);const src=path.join(__dirname,name),actual=fileMeta(src);if(actual.bytes!==(expected.bytes??expected.size)||actual.sha256!==expected.sha256)throw Error('Frozen CPU file changed '+name);return src;}
 if(rd.slice(9)!==config.readme?.file)throw Error('Wrong frozen README');verifyFile(config.readme.file,config.readme);
 const freeze=read(path.join(__dirname,'x51-c15-curation-input-freeze.json'));
 for(const name of Object.values(input).flat())verifyFile(name,freeze.files[name]);
 function exactSources(label,recordedHead,dirtySource,hashes,commit){for(const [file,sha256]of Object.entries(hashes)){if(hash(A.gitFile(commit,file))!==sha256)throw Error('Exact CPU source mismatch '+label+'/'+file);sourceMap.push({case:label,file,recordedHead,dirtySource,recordedSha256:sha256,verifiedBytesAtCommit:commit,scope:'Byte identity verified; original recorded run head/dirty status preserved.'});}}
 const hidden=read(path.join(__dirname,'x51-c15-hidden-audit.json'));
 for(const e of hidden.artifacts)verifyFile(e.name,e);
 const before=read(path.join(__dirname,'x51-c15-hidden-before.json')),after=read(path.join(__dirname,'x51-c15-hidden-after.json'));
 if(before.head!==config.historicalHead||before.dirtySource!==false||after.head!==config.historicalHead||after.dirtySource!==true||hidden.saved!==516)throw Error('Hidden before/after scope changed');
 exactSources('hidden-before',before.head,false,before.sourceHashes,config.historicalHead);
 for(const [file,sha256]of Object.entries(after.sourceHashes)){
  if(hidden.sourceHashes[file]!==sha256)throw Error('Hidden audit/result hash differs');
  if(sha256===before.sourceHashes[file])exactSources('hidden-after',after.head,true,{[file]:sha256},config.historicalHead);
  else sourceMap.push({case:'hidden-after',file,recordedHead:after.head,dirtySource:true,recordedSha256:sha256,verification:'Frozen intermediate report and proof input hashes only; intermediate source bytes not separately retained or represented as final commit.'});
 }
 const proof=read(path.join(__dirname,'x51-c15-hidden-proof.json'));
 if(JSON.stringify(proof.sourceHashes)!==JSON.stringify(after.sourceHashes))throw Error('Hidden proof source mismatch');
 const terrainHelper=path.resolve(__dirname,'../asset-candidates/mirzaev-highrise/terrain-cpu-methods.mjs');
 const proofFiles=new Set(['x51-c15-hidden-before.json','x51-c15-hidden-after.json','x51-c15-hidden-city-cpu.mjs','x51-c15-hidden-proof.mjs'].map(n=>path.resolve(__dirname,n)).concat([terrainHelper]));
 const proofSource=['upstream/sakuragaoka/src/world/layout.js','src/skyline.js','src/transition.js'];
 if(Object.keys(proof.inputHashes).length!==8)throw Error('Hidden proof dependency scope changed');
 for(const [file,sha]of Object.entries(proof.inputHashes)){const resolved=path.resolve(file),source=proofSource.find(n=>path.resolve(fixture,n)===resolved);if(source){if(hash(A.gitFile(config.historicalHead,source))!==sha)throw Error('Hidden ground source mismatch');}else if(!proofFiles.has(resolved)||hash(fs.readFileSync(resolved))!==sha)throw Error('Hidden proof dependency mismatch');}
 A.gzip(terrainHelper,'cpu/shared/terrain-cpu-methods.mjs.gz');
 for(const name of input.hidden)copyEvidence(path.join(__dirname,name),'cpu/hidden/'+name);
 const facade=read(path.join(__dirname,'x51-c15-facade-audit.json'));
 for(const [name,meta]of Object.entries(facade.files))verifyFile(name,meta);
 const final=read(path.join(__dirname,'x51-c15-facade-city-result.json'));
 if(facade.actualExitCode!==0||final.dirtySource!==true||final.stats.totalTriangles!==29933||final.stats.facadeLife.totalTriangles!==896)throw Error('Final facade CPU scope changed');
 exactSources('final-facade',final.head,true,final.sourceHashes,head);
 for(const name of input.facade)copyEvidence(path.join(__dirname,name),'cpu/facade/'+name);
 const early=read(path.join(__dirname,'x51-p2-service-cpu-result.json')),service=read(path.join(__dirname,'x51-p2-service-cpu-final.json'));
 if(!service.ok||service.stats.serviceDetailTriangles!==18)throw Error('Final service CPU mismatch');
 exactSources('final-service',null,true,{'src/streetscape.js':service.sourceSha256},head);
 sourceMap.push({case:'earlier-service',file:'src/streetscape.js',recordedSha256:early.sourceSha256,verification:'Historical dirty report hash; no assertion that this intermediate source equals final commit.'});
 for(const name of input.service)copyEvidence(path.join(__dirname,name),'cpu/service/'+name);
 A.copy(path.join(__dirname,'x51-c15-curation-input-freeze.json'),'source-map/external-input-freeze.json');
 A.json({cases:sourceMap,failureScope:'Original ctx.onUpdate driver failure stderr retained. Corrected current CPU driver is not claimed to be the failing driver original bytes; no source snapshot was stored for that failure.',serviceActualExit:config.serviceActualExit,cpuScope:'CPU geometry/material construction and recorded assertions; canvas/image pixels mocked. No GPU visual proof. Hidden proof applies only to its before/after pair.'},'source-map/cpu-states.json');
 const outcomes=[];
 for(const spec of config.runs){
  const run=path.join(fixture,'artifacts',safe(spec.directory)),r=read(path.join(run,spec.report)),runConfig=read(path.join(run,'run-config.json'));
  if(r.stage!=='complete'||read(path.join(run,'process.json')).pid!==spec.pid||!Number.isInteger(spec.exit)||!Number.isInteger(spec.session))throw Error('Actual completed process mismatch '+spec.directory);
  const source=A.sourceManifest(path.join(run,'source-manifest.json'),head,assets,!!spec.baseline);
  if(runConfig.sourceManifest?.sha256&&runConfig.sourceManifest.sha256!==source.sha256)throw Error('Run config/source mismatch');
  for(const name of ['source-manifest.json','run-config.json','process.json'])A.copy(path.join(run,name),spec.label+'/'+name);
  A.gzip(path.join(run,spec.report),spec.label+'/'+spec.report+'.gz');A.gzip(path.join(run,'electron.log'),spec.label+'/electron.log.gz');
  const images=spec.baseline?['01-station-street.jpg','02-station-port.jpg','03-island-aerial.jpg','04-shop-interior.jpg','18-town-shop-balconies.jpg','19-town-rear-stairs.jpg','23-service-corner.jpg','24-laundry-details.jpg','walking-first.jpg','walking-third.jpg']:views.map(v=>v+'-ao-on-capture-2.jpg').concat(['21-front-eye','laundry-details','shop-interior'].map(v=>v+'-ao-on-capture-2.png'));
  if(!spec.baseline){
   if(r.headAfter!==head||r.captures.length!==21||r.restoreTargetSha256!==r.restoreStateSha256||r.restoreUnchanged!==true)throw Error('Unexpected C15 diagnostic contract');
   A.receipt(read(path.join(run,'prop-assets-manifest.json')),assets);
   if(hash(fs.readFileSync(path.join(__dirname,safe(spec.driver))))!==runConfig.driverSha256)throw Error('Diagnostic driver changed');
   A.copy(path.join(__dirname,spec.driver),spec.label+'/'+spec.driver);A.copy(path.join(run,'prop-assets-manifest.json'),spec.label+'/prop-assets-manifest.json');
   for(const name of spec.readbacks)A.copy(path.join(run,safe(name)),spec.label+'/'+name);
   for(const [file,key]of [['city-shadow-audit.json','cityShadowAudit'],['wall-material-audit.json','wallMaterialAudit'],['scene-assets-audit.json','sceneAssetsAudit']])if(JSON.stringify(read(path.join(run,file)))!==JSON.stringify(r[key]))throw Error('Actual readback differs from full report '+file);
   for(const ref of [{file:'c14-reference.json',archive:'look-c14-2026-11-17'},{file:'c12-reference.json',archive:'look-c12-2026-11-17'}]){const value=read(path.join(run,ref.file));if(hash(zlib.gunzipSync(A.gitFile(head,'evidence/'+ref.archive+'/diagnostic/look-report.json.gz')))!==(value.reference?.sha256??value.sha256)||hash(A.gitFile(head,'evidence/'+ref.archive+'/diagnostic/source-manifest.json'))!==value.sourceManifestSha256)throw Error('Historical reference changed '+ref.file);}
   const expected=new Set(views.flatMap(v=>['warmup','capture-1','capture-2'].map(p=>v+'-ao-on-'+p))),records=[];
   for(const c of r.captures){if(!expected.delete(c.name))throw Error('Unexpected capture '+c.name);const files={};for(const ext of ['png','jpg']){const name=safe(c.name+'.'+ext),bytes=fs.readFileSync(path.join(run,name));files[ext]={filename:name,bytes:bytes.length,sha256:hash(bytes),copiedToArchive:images.includes(name)};}if(files.png.sha256!==c.pngSha256)throw Error('PNG changed');records.push({...c,files});}
   if(expected.size)throw Error('Missing captures');A.json({artifact:spec.directory,records,scope:'All21 original captures indexed; selected unchanged images. No implicit AO-off, tap or shadow-ABA experiment.'},spec.label+'/capture-index.json');
  }
  for(const image of images)A.copy(path.join(run,image),spec.label+'/'+image);
  const frames=fs.readdirSync(run).filter(n=>/^frame-samples.*\.json$/.test(n));for(const name of frames)A.copy(path.join(run,name),spec.label+'/'+name);
  const outcome={artifact:spec.directory,head,pid:spec.pid,session:spec.session,actualExit:spec.exit,stage:r.stage,renderOk:r.renderOk,transportClean:r.transportClean,source};outcomes.push(outcome);
  A.json({...outcome,networkFailures:r.networkFailures,failedRequestTiming:r.failedRequestTiming,exceptions:r.exceptions,httpErrors:r.httpErrors,failure:r.failure,performance:r.performance,views:r.views?.map(({scene,...v})=>v),walkingValidation:r.walkingValidation,behaviorValidation:r.behaviorValidation,lookValidation:r.lookValidation,firstReady:r.firstReady,initial:r.initial,restoreUnchanged:r.restoreUnchanged,sourceUnchanged:r.sourceUnchanged,driverUnchanged:r.driverUnchanged,assetsUnchanged:r.assetsUnchanged,selectedImages:images,frameSamples:frames},spec.label+'/measurements.json');
 }
 // Runtime analysis validation is deliberately supplied after inspecting its
 // real schema, rather than inheriting C14 wall/readback fields as assumptions.
 if(!config.analysis.validationModule)throw Error('Frozen C15 analysis schema validator not supplied');
 const analysisSummary=require(path.join(__dirname,safe(config.analysis.validationModule)))({A,fixture,head,config});
 A.copy(path.join(__dirname,config.analysis.validationModule),'analysis/'+config.analysis.validationModule);
 let ci=null;
 if(config.ci){
  const prefix=safe(config.ci.prefix);ci=read(path.join(__dirname,prefix+'summary.json'));
  if(ci.head!==head||ci.logSha256!==hash(fs.readFileSync(path.join(__dirname,prefix+'log.json'))))throw Error('CI exact head/log mismatch');
  for(const suffix of ['summary.json','summary.cjs','checks.json','jobs.json','run.json','runs.json','provenance.json']){const name=prefix+suffix;verifyFile(name,config.ci.files[name]);A.copy(path.join(__dirname,name),'ci/'+name);}
  const provenance=read(path.join(__dirname,prefix+'provenance.json'));
  if(provenance.sourceHead!==head||JSON.stringify(provenance.scope)!==JSON.stringify(ci.actualCheckout))throw Error('CI merge-checkout scope mismatch');
  for(const entry of provenance.files){const name=path.basename(entry.path);if(path.resolve(entry.path)!==path.resolve(__dirname,name)||!config.ci.files[name])throw Error('Unexpected CI provenance file');verifyFile(name,entry);}
  verifyFile(prefix+'log.json',config.ci.files[prefix+'log.json']);A.gzip(path.join(__dirname,prefix+'log.json'),'ci/job-log.json.gz');
 }
 const prior=['evidence/look-c14-2026-11-17/README.md','evidence/look-c14-2026-11-17/diagnostic/look-report.json.gz'];
 A.json(prior.map(file=>({file:'../'+file.slice(9),presentInCommit:head,sha256:hash(A.gitFile(head,file)),copied:false})),'prior-references.json');
 for(const name of ['x51-curate-c15.cjs','x51-curation-core.cjs','x51-verify-evidence.cjs'])A.copy(path.join(__dirname,name),name);
 A.copy(configFile,'curation-config.json');A.copy(path.join(__dirname,rd.slice(9)),'README.md');
 A.queue(Buffer.from('*.gz binary\n*.png binary\n*.jpg binary\n*.json -text\n*.cjs -text\n*.mjs -text\n*.md -text\n'),'.gitattributes');
 A.json({head,outcomes,analysisSummary,ci,scope:'Different dirty CPU stages retained separately; final GPU exact Git source/9asset bytes checked. Original failures and actual exits retained. Full reports/logs lossless gzip. No asset originals/cache/user profile. No scene execution or GitHub writes by curator.'},'summary.json');
 console.log(JSON.stringify(A.finish(head),null,2));
}
if(require.main===module){try{main();}catch(e){console.error(e);process.exitCode=1;}}
