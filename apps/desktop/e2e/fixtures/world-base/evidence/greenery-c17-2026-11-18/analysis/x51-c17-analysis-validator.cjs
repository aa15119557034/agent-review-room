const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {read,hash}=require('./x51-curation-core.cjs');
module.exports=function({A,c,fixture,checkFile,external}){
 const j=read(path.join(__dirname,'x51-c17-offline-analysis.json'));
 if(j.sourceHead!==c.head||j.comparisons.length!==7||j.repeats.length!==17||j.aba.length!==4||j.seamAcrossRounds.length!==6||j.normal.segments.length!==7)throw Error('C17 actual analysis schema mismatch');
 for(const e of Object.values(j.reports))checkFile(e.path,e);
 for(const s of j.normal.segments)checkFile(path.join(path.dirname(j.reports.normal.path),s.samplesFile),{sha256:s.samplesSha256});
 const current=read(j.reports.diagnostic.path),old=JSON.parse(zlib.gunzipSync(A.gitFile(c.head,'evidence/greenery-c16-2026-11-18/diagnostic/look-report.json.gz')));
 const captures=[...current.captures,...current.townCaptures],prior=[...old.captures,...old.townCaptures];
 function pair(row,a,b){if(!a||!b)throw Error('Missing compared frame');for(const [key,actual]of [['pngEqual',a.pngSha256===b.pngSha256],['cameraEqual',JSON.stringify(a.camera)===JSON.stringify(b.camera)],['timeEqual',a.time===b.time],['paramsEqual',JSON.stringify(a.params)===JSON.stringify(b.params)]])if(row[key]!==actual)throw Error('Analysis metadata/PNG comparison mismatch '+key);}
 for(const row of [...j.comparisons,...j.seamAcrossRounds])pair(row,prior.find(x=>x.name===row.a),captures.find(x=>x.name===row.b));
 for(const row of j.repeats)pair(row,captures.find(x=>x.name===row.a),captures.find(x=>x.name===row.b));
 for(const row of j.aba)for(const key of ['onOff','restoration'])pair(row[key],captures.find(x=>x.name===row[key].a),captures.find(x=>x.name===row[key].b));
 const townFile=path.join(path.dirname(j.reports.diagnostic.path),'town-material-audit.json');checkFile(townFile,{sha256:j.diagnostic.townAuditSha256});const town=read(townFile);
 for(const file of ['x51-c17-offline-analysis.cjs','x51-c17-offline-analysis.json','x51-c17-offline-analysis-stdout.json','x51-c17-offline-analysis-stderr.txt'])external(file,'analysis');
 A.json(c.analysis.execution,'analysis/offline-execution-source.json');
 return {comparisons:j.comparisons.length,repeats:j.repeats.length,abaGroups:j.aba.length,seamAcrossRounds:j.seamAcrossRounds.length,normalSegments:j.normal.segments.map(s=>({name:s.name,frames:s.frameCount,longFramesOver20ms:s.longFramesOver20ms.length,maxFrameMs:s.maxFrameMs})),townReadback:{materials:town.materials.length,programs:Object.keys(town.programs).length,rawSources:Object.keys(town.sources).length,allTown:town.materials.every(m=>m.hasTownDefinition),allSharedUniforms:town.materials.every(m=>m.sameRectAsTerrain&&m.sameGreenAsTerrain),allProgramsCompiledLinked:Object.values(town.programs).every(p=>p.linked&&p.vertexCompiled&&p.fragmentCompiled)},scope:'Frozen root offline RGB measurements copied without recomputation; PNG identity/camera/time/params independently checked against current and archived C16 reports. Actual readback status reported, not used to force a passing result. Visual interpretation belongs to root README; single-look GPU run is not a cross-look leakage test.'};
};
