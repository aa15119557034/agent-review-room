// Validates the actual C15 root offline output and execution-agent receipts.
const fs=require('node:fs'),path=require('node:path');
const {read,hash,safe}=require('./x51-curation-core.cjs');
module.exports=function({A,fixture,head,config}){
 const files=config.analysis.files;
 if(!files||['x51-c15-execution-receipt.json','x51-c15-atlas-execution-summary.json','x51-c15-atlas-execution-summary.md','x51-c15-offline-analysis.cjs','x51-c15-offline-analysis.json'].some(n=>!files[n]))throw Error('Frozen analysis file list required');
 for(const [name,meta]of Object.entries(files)){safe(name);const file=path.join(__dirname,name),b=fs.readFileSync(file);if(b.length!==meta.bytes||hash(b)!==meta.sha256)throw Error('Analysis file changed '+name);A.copy(file,'analysis/'+name);}
 const receipt=read(path.join(__dirname,'x51-c15-execution-receipt.json'));
 if(receipt.schema!=='x51-c15-execution-receipt-v1'||receipt.sourceHead!==head||receipt.serviceCPU.actualExit!==config.serviceActualExit)throw Error('Execution receipt scope mismatch');
 const artifacts=config.runs.map(s=>fs.realpathSync(path.join(fixture,'artifacts',s.directory)));
 const external=new Set(['x51-c15-normal-stdout.txt','x51-c15-normal-stderr.txt','x51-c15-targeted-stdout.txt','x51-c15-targeted-stderr.txt','x51-p2-service-cpu-final.json','x51-p2-service-cpu-final-stderr.txt','x51-p2-service-cpu.mjs','x51-c15-diagnostic-gpu.cjs'].map(n=>path.resolve(__dirname,n)));
 const seen=new Set();
 for(const entry of receipt.evidenceHashes){const real=fs.realpathSync(entry.path),resolved=path.resolve(real),inside=artifacts.some(root=>{const rel=path.relative(root,real);return rel&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);});if(seen.has(resolved)||(!inside&&!external.has(resolved)))throw Error('Unexpected/duplicate receipt input');seen.add(resolved);if(hash(fs.readFileSync(real))!==entry.sha256)throw Error('Receipt input changed '+real);}
 for(const spec of config.runs){const item=receipt.runs.find(r=>r.kind===(spec.baseline?'normal':'targeted'));if(!item||item.actualExit!==spec.exit||item.pid!==spec.pid||item.session!==spec.session||path.resolve(item.directory)!==path.resolve(fixture,'artifacts',spec.directory))throw Error('Actual process/receipt mismatch');for(const file of [item.stdout,item.stderr])A.gzip(file,spec.label+'/'+path.basename(file)+'.gz');}
 const target=path.join(fixture,'artifacts',config.runs.find(s=>!s.baseline).directory),normal=path.join(fixture,'artifacts',config.runs.find(s=>s.baseline).directory);
 const report=read(path.join(target,'look-report.json')),baseline=read(path.join(normal,'render-report.json'));
 const atlas=read(path.join(__dirname,'x51-c15-atlas-execution-summary.json'));
 if(atlas.schema!=='x51-c15-atlas-execution-summary-v1'||atlas.sourceHead!==head||atlas.rawAuditSha256!==hash(fs.readFileSync(path.join(target,'scene-assets-audit.json')))||atlas.receiptSha256!==hash(fs.readFileSync(path.join(__dirname,'x51-c15-execution-receipt.json'))))throw Error('Atlas execution summary mismatch');
 if(atlas.regions.length!==3)throw Error('Unexpected atlas crop count');
 for(const region of atlas.regions){const name=safe(region.file);if(path.resolve(region.path)!==path.resolve(target,name)||hash(fs.readFileSync(region.path))!==region.pngSha256)throw Error('Atlas PNG changed');const raw=report.sceneAssetsAudit.laundryRegions.find(r=>r.key===region.key);if(!raw||raw.rgbaSha256!==region.rgbaSha256||raw.file!==name)throw Error('Atlas crop/raw report mismatch');}
 const analysis=read(path.join(__dirname,'x51-c15-offline-analysis.json'));
 if(analysis.sourceHead!==head||analysis.comparisons.length!==7||analysis.repeats.length!==7)throw Error('Root offline analysis scope mismatch');
 for(const [key,file]of [['diagnostic',path.join(target,'look-report.json')],['normal',path.join(normal,'render-report.json')]])if(path.resolve(analysis.reports[key].path)!==path.resolve(file)||analysis.reports[key].sha256!==hash(fs.readFileSync(file)))throw Error('Root analysis input changed');
 const oldReport=JSON.parse(require('node:zlib').gunzipSync(A.gitFile(head,'evidence/look-c14-2026-11-17/diagnostic/look-report.json.gz')));
 for(const row of analysis.comparisons){const name=safe(row.name+'.png'),current=report.captures.find(c=>c.name===row.name);if(!current||current.pngSha256!==row.currentSha256||hash(fs.readFileSync(path.join(target,name)))!==row.currentSha256)throw Error('Comparison current image mismatch');const old=oldReport.captures.find(c=>c.name===row.name);if(!old||old.pngSha256!==row.beforeSha256)throw Error('Comparison historical PNG hash mismatch');}
 for(const segment of analysis.normal.segments){const file=path.join(normal,safe(segment.samplesFile));if(hash(fs.readFileSync(file))!==segment.samplesSha256||read(file).length!==segment.frameCount)throw Error('Frame samples changed');}
 if(JSON.stringify(analysis.cityStats)!==JSON.stringify(report.sceneAssetsAudit.cityStats)||JSON.stringify(analysis.streetscapeStats)!==JSON.stringify(report.sceneAssetsAudit.streetscapeStats)||analysis.normal.renderOk!==baseline.renderOk||analysis.normal.transportClean!==baseline.transportClean)throw Error('Analysis report scope mismatch');
 return {rootOfflineMethod:analysis.method,comparisonViews:analysis.comparisons.map(c=>({view:c.view,cameraEqual:c.cameraEqual,timeEqual:c.timeEqual,pixels:c.pixels})),repeats:analysis.repeats,pageCounts:atlas.pageCounts,actualLaundryTextCalls:atlas.actualLaundryTextCalls.length,atlasLimits:atlas.limits,executionReceiptProvenance:receipt.provenance,serviceCpuReceiptLimit:receipt.serviceCPU.limit,limits:analysis.limits};
};
