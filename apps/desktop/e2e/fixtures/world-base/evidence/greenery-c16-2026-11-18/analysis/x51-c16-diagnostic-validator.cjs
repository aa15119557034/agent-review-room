const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {read,hash}=require('./x51-curation-core.cjs');
module.exports=function({A,c,spec,r,dir,rc,checkFile,external}){
 const receipt=read(path.join(__dirname,'x51-c16-targeted-execution.json'));
 if(receipt.schema!=='x51-c16-targeted-execution-v1'||receipt.sourceHead!==c.head||receipt.pid!==spec.pid||receipt.session!==spec.session||receipt.actualExit!==spec.exit||receipt.driverSha256!==rc.driverSha256)throw Error('Targeted receipt scope mismatch');
 for(const e of receipt.evidenceHashes)checkFile(e.path,e);
 for(const name of ['x51-c16-targeted-execution.json','x51-c16-targeted-stdout.txt','x51-c16-targeted-stderr.txt'])external(name,'diagnostic');
 if(r.headAfter!==c.head||r.captures.length!==21||r.townCaptures.length!==30||receipt.imageNames.length!==51||!r.sourceUnchanged||!r.driverUnchanged||!r.assetsUnchanged||!r.restoreUnchanged||r.restoreTargetSha256!==r.restoreStateSha256)throw Error('Frozen C16 diagnostic contract differs');
 const images=[...r.captures,...r.townCaptures];
 for(const entry of receipt.imageNames){const capture=images.find(e=>e.name===entry.name);if(!capture||capture.pngSha256!==entry.pngSha256)throw Error('Receipt image hash mismatch');}
 const audit=read(path.join(dir,'town-material-audit.json'));
 for(const [file,key]of [['town-material-audit.json','townAudit'],['scene-assets-audit.json','sceneAssetsAudit'],['wall-material-audit.json','wallMaterialAudit'],['city-shadow-audit.json','cityShadowAudit']])if(JSON.stringify(read(path.join(dir,file)))!==JSON.stringify(r[key]))throw Error('Raw readback/report differs '+file);
 if(audit.glError!==0||Object.keys(audit.programs).length!==5)throw Error('Town GL audit scope changed');
 for(const [id,p]of Object.entries(audit.programs))for(const stage of ['vertex','fragment']){
  const text=p[stage+'ShaderSource'];if(typeof text!=='string'||!text.includes('void main')||hash(Buffer.from(text))!==p[stage+'ShaderSha256'])throw Error('Full original GL shader missing/corrupt '+id+'/'+stage);
 }
 for(const [sha,s]of Object.entries(audit.sources))if(typeof s.vertexShader!=='string'||typeof s.fragmentShader!=='string'||hash(Buffer.from(JSON.stringify(s)))!==sha)throw Error('Full material source hash mismatch');
 for(const m of audit.materials)if(!audit.sources[m.sourceSha256])throw Error('Material source reference missing');
 checkFile(path.join(dir,'north-seam-candidates.json'),rc.seamCandidateSource);
 const prior=read(path.join(dir,'c15-reference.json'));
 const oldReport=A.gitFile(c.head,'evidence/facade-c15-2026-11-17/diagnostic/look-report.json.gz');
 if(hash(zlib.gunzipSync(oldReport))!==prior.reference.sha256||hash(A.gitFile(c.head,'evidence/facade-c15-2026-11-17/diagnostic/source-manifest.json'))!==prior.sourceManifestSha256)throw Error('C15 exact archived reference mismatch');
 A.json({report:'../facade-c15-2026-11-17/diagnostic/look-report.json.gz',rawSha256:prior.reference.sha256,verifiedInCommit:c.head,copied:false},'source-map/prior-c15.json');
 // The inherited C12 file remains historical metadata, never presented as a C16 run.
 const old12=read(path.join(dir,'c12-reference.json'));
 if(hash(zlib.gunzipSync(A.gitFile(c.head,'evidence/look-c12-2026-11-17/diagnostic/look-report.json.gz')))!==(old12.reference?.sha256??old12.sha256))throw Error('Inherited C12 reference mismatch');
};
