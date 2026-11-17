const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {read,hash}=require('./x51-curation-core.cjs');
module.exports=function({A,c,fixture,checkFile,external}){
 const j=read(path.join(__dirname,'x51-c16-offline-analysis.json')),seam=read(path.join(__dirname,'x51-c16-seam-readback.json'));
 if(j.sourceHead!==c.head||j.comparisons.length!==7||j.repeats.length!==17||j.aba.length!==4||j.normal.segments.length!==7||seam.sourceHead!==c.head)throw Error('C16 analysis actual schema mismatch');
 for(const e of Object.values(j.reports))checkFile(e.path,e);
 for(const s of j.normal.segments)checkFile(path.join(path.dirname(j.reports.normal.path),s.samplesFile),{sha256:s.samplesSha256});
 checkFile(seam.report,{sha256:seam.reportSha256});checkFile(seam.audit,{sha256:seam.auditSha256});
 if(seam.auditSha256!==j.diagnostic.townAuditSha256)throw Error('Analysis town audit hash mismatch');
 const current=read(j.reports.diagnostic.path),old=JSON.parse(zlib.gunzipSync(A.gitFile(c.head,'evidence/facade-c15-2026-11-17/diagnostic/look-report.json.gz')));
 const captures=[...current.captures,...current.townCaptures];
 function pair(row,a,b){if(!a||!b)throw Error('Missing compared frame');for(const [key,actual]of [['pngEqual',a.pngSha256===b.pngSha256],['cameraEqual',JSON.stringify(a.camera)===JSON.stringify(b.camera)],['timeEqual',a.time===b.time],['paramsEqual',JSON.stringify(a.params)===JSON.stringify(b.params)]])if(row[key]!==actual)throw Error('Analysis metadata/PNG comparison mismatch '+key);}
 for(const row of j.comparisons)pair(row,old.captures.find(x=>x.name===row.a),captures.find(x=>x.name===row.b));
 for(const row of j.repeats)pair(row,captures.find(x=>x.name===row.a),captures.find(x=>x.name===row.b));
 for(const row of j.aba)for(const key of ['onOff','restoration'])pair(row[key],captures.find(x=>x.name===row[key].a),captures.find(x=>x.name===row[key].b));
 for(const file of ['x51-c16-offline-analysis.cjs','x51-c16-offline-analysis.json','x51-c16-seam-readback.json','x51-c16-seam-readback.md'])external(file,'analysis');
 return {comparisons:j.comparisons.length,repeats:j.repeats.length,abaGroups:j.aba.length,normalSegments:j.normal.segments.map(s=>({name:s.name,frames:s.frameCount,longFramesOver20ms:s.longFramesOver20ms.length,maxFrameMs:s.maxFrameMs})),visualFinding:seam.conclusion,scope:'Frozen root offline RGB measurements copied without recomputing pixels; PNG identities and camera/time/params comparisons independently checked against raw reports. Seam is a visible regression. CPU second-look bug is separate; no causal attribution of initial long frames.'};
};
