// External only. Prepare all source/input checks before writing; run only after root authorization.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {createArchive,read,hash,safe}=require('./x51-curation-core.cjs');
const fixture=path.resolve(__dirname,'../world-base/apps/desktop/e2e/fixtures/world-base');
const initialHead='0d97731bd7cb4f4634f4c9fdc0e1033ae7585f2a',finalHead='6b0e9c4c7453bdd612e77c03cde9f81112ae9cc3';
const views=['service-corner','laundry-details','shop-interior','20-rear-eye','21-front-eye','station-street','street-detail'];
const finalObservedExit=1; // Root actual session93115/PID28616; report complete/renderOk true, crate.bin transport cancellation retained.
function main(){
 const args=process.argv.slice(2),readmeArg=args.find(x=>x.startsWith('--readme='));
 if(!args.length||args.includes('--help')){console.log('After root authorization: node x51-curate-density.cjs --write --readme=<handoff-file.md>');return;}
 if(args.length!==2||!args.includes('--write')||!readmeArg||!/^[-\w.]+\.md$/.test(readmeArg.slice(9)))throw Error('Require --write and --readme=<handoff-file.md>');
 if(![0,1].includes(finalObservedExit))throw Error('Await actual final normal-baseline exit observation');
 const A=createArchive({fixture,out:path.join(fixture,'evidence/density-2026-11-17')});
 const assets=new Map(),sourceChecks=[],outcomes=[];
 for(const head of [initialHead,finalHead]){assets.set(head,A.pinnedAssets(head));A.json(assets.get(head),'source-map/'+head+'/pinned-assets.json');A.queue(A.gitFile(head,'prop-assets.json'),'source-map/'+head+'/prop-assets.json',{exactCommit:head});}
 const specs=[
  {label:'failed-baseline',directory:'gpu-town-density-v1',head:initialHead,report:'render-report.json',baseline:true,failed:true,pid:38628,session:16446,exit:1},
  {label:'diagnostic',directory:'gpu-density-v1',head:initialHead,report:'look-report.json',pid:52044,session:55536,exit:1,driver:'x51-density-diagnostic-gpu.cjs'},
  {label:'baseline',directory:'gpu-town-density-v2',head:finalHead,report:'render-report.json',baseline:true,pid:28616,session:93115,exit:finalObservedExit},
 ];
 for(const spec of specs){
  const run=path.join(fixture,'artifacts',spec.directory),report=read(path.join(run,spec.report)),config=read(path.join(run,'run-config.json'));
  if(spec.failed){if(report.stage!=='waiting-for-ready-frame'||report.renderOk!==false||report.captures.length!==0||report.failure?.kind!=='exception'||!report.exceptions.some(e=>e.exception?.description?.includes('Object.entries')))throw Error('Initial failure changed; investigate');}
  else if(report.stage!=='complete')throw Error('Run not complete '+spec.directory);
  const source=A.sourceManifest(path.join(run,'source-manifest.json'),spec.head,assets.get(spec.head),!!spec.baseline);sourceChecks.push({artifact:spec.directory,...source});
  if(config.sourceManifest?.sha256&&config.sourceManifest.sha256!==source.sha256)throw Error('Config/source mismatch');
  if(read(path.join(run,'process.json')).pid!==spec.pid)throw Error('Actual runner PID mismatch '+spec.directory);
  for(const file of ['source-manifest.json','run-config.json','process.json'])A.copy(path.join(run,file),spec.label+'/'+file);
  A.gzip(path.join(run,'electron.log'),spec.label+'/electron.log.gz');A.gzip(path.join(run,spec.report),spec.label+'/'+spec.report+'.gz');
  const selected=spec.failed?[]:spec.baseline?['01-station-street.jpg','02-station-port.jpg','03-island-aerial.jpg','04-shop-interior.jpg','19-town-rear-stairs.jpg','23-service-corner.jpg','24-laundry-details.jpg','walking-first.jpg','walking-third.jpg']:views.map(v=>v+'-ao-on-capture-2.jpg').concat(['service-corner','laundry-details','street-detail'].map(v=>v+'-ao-on-capture-2.png'));
  if(!spec.baseline){
   if(report.headAfter!==spec.head||report.captures.length!==21||report.shadowFlagCaptures)throw Error('Unexpected density diagnostic scope');
   A.receipt(read(path.join(run,'prop-assets-manifest.json')),assets.get(spec.head));
   if(hash(fs.readFileSync(path.join(__dirname,spec.driver)))!==config.driverSha256)throw Error('Driver changed');
   A.copy(path.join(__dirname,spec.driver),spec.label+'/'+spec.driver);
   for(const file of ['prop-assets-manifest.json','c12-reference.json','city-shadow-audit.json'])A.copy(path.join(run,file),spec.label+'/'+file);
   if(JSON.stringify(read(path.join(run,'city-shadow-audit.json')))!==JSON.stringify(report.cityShadowAudit))throw Error('Standalone city readback mismatch');
   const ref=read(path.join(run,'c12-reference.json')),oldReport=A.gitFile(spec.head,'evidence/look-c12-2026-11-17/diagnostic/look-report.json.gz'),oldSource=A.gitFile(spec.head,'evidence/look-c12-2026-11-17/diagnostic/source-manifest.json');
   if(ref.reference.head!=='e38dd51a294da3a498b9404c0f27b854d16a2fd5'||hash(zlib.gunzipSync(oldReport))!==ref.reference.sha256||hash(oldSource)!==ref.sourceManifestSha256)throw Error('Historical C12 source/reference mismatch');
   const index=[],expected=new Set(views.flatMap(v=>['warmup','capture-1','capture-2'].map(p=>v+'-ao-on-'+p)));
   for(const cap of report.captures){if(!expected.delete(cap.name))throw Error('Unexpected/duplicate capture '+cap.name);const files={};for(const ext of ['png','jpg']){const name=safe(cap.name+'.'+ext),bytes=fs.readFileSync(path.join(run,name));files[ext]={filename:name,bytes:bytes.length,sha256:hash(bytes),copiedToArchive:selected.includes(name)};}if(files.png.sha256!==cap.pngSha256)throw Error('Capture changed '+cap.name);index.push({name:cap.name,view:cap.view,pass:cap.pass,camera:cap.camera,time:cap.time,uploadedAO:cap.uploadedAO,files});}
   if(expected.size)throw Error('Missing density captures');A.json({artifact:spec.directory,records:index,allCaptureMetadata:spec.report+'.gz',scope:'All 21 original frames indexed. Seven default-AO views, each warmup plus two captures; no AO-off, HDR/tap or shadow ABA. Six C12 reference cameras; street-detail is new and unpaired.'},spec.label+'/capture-index.json');
  }
  for(const image of selected)A.copy(path.join(run,image),spec.label+'/'+image);
  const frames=fs.readdirSync(run).filter(n=>/^frame-samples.*\.json$/.test(n));for(const file of frames)A.copy(path.join(run,file),spec.label+'/'+file);
  const summary={source,stage:report.stage,ok:report.ok,renderOk:report.renderOk,transportClean:report.transportClean,actualExit:spec.exit,session:spec.session,pid:spec.pid,failure:report.failure,exceptions:report.exceptions,networkFailures:report.networkFailures,failedRequestTiming:report.failedRequestTiming,performance:report.performance,views:report.views?.map(({scene,...v})=>v),walkingValidation:report.walkingValidation,behaviorValidation:report.behaviorValidation,lookValidation:report.lookValidation,firstReady:report.firstReady,initial:report.initial,restore:report.restore,sourceUnchanged:report.sourceUnchanged,driverUnchanged:report.driverUnchanged,assetsUnchanged:report.assetsUnchanged,selectedImages:selected,frameSamples:frames,scope:spec.failed?'Snapshot exception before capture. No normal-baseline performance/walking/visual pass established.':spec.baseline?'Normal baseline of separately identified metadata-fix commit; does not rewrite the original failure.':'Fixed-time density readback/visual evidence, not performance or navigation proof.'};
  A.json(summary,spec.label+'/measurements.json');outcomes.push({artifact:spec.directory,head:spec.head,stage:report.stage,renderOk:report.renderOk,transportClean:report.transportClean,actualExit:spec.exit,session:spec.session,pid:spec.pid});
 }
 const originalFiles=read(path.join(fixture,'artifacts/gpu-density-v1/source-manifest.json')).files,finalFiles=read(path.join(fixture,'artifacts/gpu-town-density-v2/source-manifest.json')).files;
 const changes=Object.keys(originalFiles).filter(name=>Object.hasOwn(finalFiles,name)&&originalFiles[name]!==finalFiles[name]).map(name=>({file:name,beforeSha256:originalFiles[name],afterSha256:finalFiles[name]}));
 const coverageOnly=[...new Set([...Object.keys(originalFiles),...Object.keys(finalFiles)])].filter(name=>Object.hasOwn(originalFiles,name)!==Object.hasOwn(finalFiles,name));
 if(coverageOnly.length!==1||coverageOnly[0]!=='scripts/diagnose-wet-road.cjs'||hash(A.gitFile(initialHead,coverageOnly[0]))!==hash(A.gitFile(finalHead,coverageOnly[0])))throw Error('Unexpected manifest coverage difference');
 if(changes.length!==1||changes[0].file!=='src/streetscape.js')throw Error('Unexpected metadata-fix source changes; review separately');
 A.json({before:initialHead,after:finalHead,changes,manifestCoverageOnly:coverageOnly.map(file=>({file,diagnosticIncluded:Object.hasOwn(originalFiles,file),baselineIncluded:Object.hasOwn(finalFiles,file),bothCommitSha256:hash(A.gitFile(initialHead,file))})),scope:'Among inputs present in both manifests, only streetscape bytes differ. The diagnostic additionally records diagnose-wet-road.cjs, whose exact Git bytes match both commits; absence from normal manifest is not a source deletion. This is not proof of geometry or visual identity.'},'source-map/metadata-fix-source-change.json');
 const analysis=read(path.join(__dirname,'x51-density-v1-analysis.json'));
 if(analysis.schema!=='x51-density-fixed-look-v1'||analysis.source.head!==initialHead||analysis.process.pid!==52044||analysis.process.actualExit!==1)throw Error('Wrong density analysis');
 const fixedRun=path.join(fixture,'artifacts/gpu-density-v1'),allowedExternal=['x51-density-diagnostic-gpu.cjs','x51-density-offline-analysis.cjs','x51-density-v1-numeric.json'];
 const expectedHashedInputs=['look-report.json','source-manifest.json','prop-assets-manifest.json','city-shadow-audit.json','c12-reference.json'].map(file=>path.join(fixedRun,file)).concat(allowedExternal.map(file=>path.join(__dirname,file)));
 for(const file of expectedHashedInputs)if(!Object.keys(analysis.evidenceHashes).some(p=>path.resolve(p)===path.resolve(file)))throw Error('Analysis missing expected hash '+file);
 for(const [file,sha]of Object.entries(analysis.evidenceHashes)){const real=fs.realpathSync(file),rel=path.relative(fs.realpathSync(fixedRun),real),inside=rel!==''&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);if(!inside&&!allowedExternal.includes(path.relative(__dirname,real)))throw Error('Unexpected evidence path');if(hash(fs.readFileSync(real))!==sha)throw Error('Analysis evidence changed '+file);}
 if(hash(fs.readFileSync(path.join(fixture,'artifacts/gpu-town-density-v1/render-report.json')))!==analysis.normalBaselineFailure.sha256)throw Error('Initial failure differs from analysis');
 for(const file of ['x51-density-v1-analysis.json','x51-density-v1-analysis.md','x51-density-v1-numeric.json','x51-density-offline-analysis.cjs'])A.copy(path.join(__dirname,file),'analysis/'+file);
 const cpu=read(path.join(__dirname,'x51-density-cpu-audit.json')),binding=read(path.join(__dirname,'x51-density-cpu-source-binding-0d97731.json'));
 if(binding.targetCommit!==initialHead)throw Error('CPU binding belongs to another head');
 for(const entry of binding.reports){if(hash(fs.readFileSync(path.join(__dirname,safe(entry.report))))!==entry.reportSha256)throw Error('CPU report changed');for(const source of entry.sources){const bytes=A.gitFile(initialHead,source.path);if(bytes.length!==source.bytes||hash(bytes)!==source.cpuSha256||source.commitSha256!==source.cpuSha256||source.matches!==true)throw Error('CPU exact source binding mismatch');}}
 for(const [file,expected]of Object.entries(cpu.files)){safe(file);const src=path.join(__dirname,file),bytes=fs.readFileSync(src);if(bytes.length!==expected.bytes||hash(bytes)!==expected.sha256)throw Error('CPU artifact mismatch '+file);if(file.endsWith('.txt')||file==='x51-density-station-cpu.mjs')A.gzip(src,'cpu/'+file+'.gz');else A.copy(src,'cpu/'+file);}
 for(const file of ['x51-density-cpu-audit.json','x51-density-cpu-source-binding-0d97731.json'])A.copy(path.join(__dirname,file),'cpu/'+file);
 const metadataNote=read(path.join(__dirname,'x51-density-cpu-metadata-note-6b0e9c4.json'));
 if(metadataNote.from!==initialHead||metadataNote.to!==finalHead||metadataNote.path!=='src/streetscape.js'||hash(A.gitFile(initialHead,metadataNote.path))!==metadataNote.oldSha256||hash(A.gitFile(finalHead,metadataNote.path))!==metadataNote.newSha256)throw Error('CPU metadata note source hashes mismatch');
 A.copy(path.join(__dirname,'x51-density-cpu-metadata-note-6b0e9c4.json'),'cpu/x51-density-cpu-metadata-note-6b0e9c4.json');
 const visual=read(path.join(__dirname,'x51-density-visual-readonly.json'));
 if(visual.source!==initialHead||visual.artifactDirectory!=='artifacts/gpu-density-v1')throw Error('Visual review source mismatch');
 for(const file of visual.files)if(!views.some(view=>file===view+'-ao-on-capture-2.jpg')||!fs.existsSync(path.join(fixedRun,safe(file))))throw Error('Unexpected visual review image');
 A.copy(path.join(__dirname,'x51-density-visual-readonly.json'),'analysis/x51-density-visual-readonly.json');
 A.json({scope:'Original dirty-sampled CPU evidence retained; source-byte binding to 0d97731 is post-hoc and only covers explicitly hashed files. Initial station result/stderr retained. No clean-checkout, all-transitive-input, GPU or full-navigation claim.'},'cpu/scope.json');
 for(const [prefix,head]of [['x51-density-ci',initialHead],['x51-density-metadata-ci',finalHead]]){const ci=read(path.join(__dirname,prefix+'-summary.json'));if(ci.head!==head||ci.logSha256!==hash(fs.readFileSync(path.join(__dirname,prefix+'-log.json'))))throw Error('CI head/log mismatch');for(const suffix of ['summary.json','summary.cjs','jobs.json','checks.json'])A.copy(path.join(__dirname,prefix+'-'+suffix),'ci/'+prefix+'-'+suffix);A.gzip(path.join(__dirname,prefix+'-log.json'),'ci/'+prefix+'-log.json.gz');}
 const references=['evidence/look-c12-2026-11-17/README.md','evidence/look-c12-2026-11-17/diagnostic/look-report.json.gz'];A.json(references.map(file=>({file:'../'+file.slice('evidence/'.length),presentInCommit:initialHead,sha256:hash(A.gitFile(initialHead,file)),copied:false})),'prior-references.json');
 A.copy(__filename,'curate-density.cjs');A.copy(path.join(__dirname,'x51-curation-core.cjs'),'x51-curation-core.cjs');A.copy(path.join(__dirname,'x51-verify-evidence.cjs'),'verify-evidence.cjs');
 A.copy(path.join(__dirname,readmeArg.slice(9)),'README.md');A.queue(Buffer.from('*.gz binary\n*.png binary\n*.jpg binary\n*.json -text\n*.cjs -text\n*.mjs -text\n*.md -text\n'),' .gitattributes'.trim());
 A.json({createdAt:new Date().toISOString(),initialHead,finalHead,sourceChecks,outcomes,scope:'Separate exact source commits and actual process exits. Original failure and all transport errors retained. All original 21 records retained, selected images unchanged, logs losslessly compressed. No scene/GPU/remote write performed by curator.'},'summary.json');
 console.log(JSON.stringify(A.finish(finalHead),null,2));
}
if(require.main===module){try{main();}catch(error){console.error(error);process.exitCode=1;}}
