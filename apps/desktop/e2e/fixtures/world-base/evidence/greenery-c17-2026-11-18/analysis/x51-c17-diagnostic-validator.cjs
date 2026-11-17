// Draft: actual receipt/readback contracts are supplied only after runtime freezes C17.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {read,hash}=require('./x51-curation-core.cjs');
module.exports=function({A,c,spec,r,dir,rc,checkFile,external}){
 if(!spec.observedContract)throw Error('C17 diagnostic actual schema not frozen');
 const receipt=read(path.join(__dirname,spec.execution));
 if(receipt.sourceHead!==c.head||receipt.pid!==spec.pid||receipt.session!==spec.session||receipt.actualExit!==spec.exit||receipt.driverSha256!==rc.driverSha256)throw Error('Targeted receipt mismatch');
 for(const e of receipt.evidenceHashes)checkFile(e.path,e);
 for(const name of [spec.execution,'x51-c17-targeted-stdout.txt','x51-c17-targeted-stderr.txt'])external(name,'diagnostic');
 if(r.headAfter!==c.head||r.captures.length!==21||r.townCaptures.length!==30||receipt.imageNames.length!==51)throw Error('Capture schema changed');
 const images=[...r.captures,...r.townCaptures];
 for(const e of receipt.imageNames){const found=images.find(v=>v.name===e.name);if(!found||found.pngSha256!==e.pngSha256)throw Error('Receipt image differs');}
 // Preserve observed failures; do not require a successful exit, restoration,
 // compilation, transport or visual result merely to archive its evidence.
 for(const [key,value]of Object.entries(spec.observedContract))if(r[key]!==value)throw Error('Frozen observed state changed '+key);
 for(const [file,key]of spec.readbackPairs)if(JSON.stringify(read(path.join(dir,file)))!==JSON.stringify(r[key]))throw Error('Raw readback differs '+file);
 const audit=read(path.join(dir,'town-material-audit.json'));
 for(const [id,p]of Object.entries(audit.programs))for(const stage of ['vertex','fragment']){
  const text=p[stage+'ShaderSource'];if(typeof text!=='string'||!text.includes('void main')||hash(Buffer.from(text))!==p[stage+'ShaderSha256'])throw Error('Full GL shader missing/corrupt '+id+'/'+stage);
 }
 for(const [sha,s]of Object.entries(audit.sources))if(typeof s.vertexShader!=='string'||typeof s.fragmentShader!=='string'||hash(Buffer.from(JSON.stringify(s)))!==sha)throw Error('Raw material source mismatch');
 const old=A.gitFile(c.head,'evidence/greenery-c16-2026-11-18/cpu/x51-c16-north-seam-views.json');
 if(hash(fs.readFileSync(path.join(dir,'north-seam-candidates.json')))!==hash(old))throw Error('Inherited C16 candidates changed');
 checkFile(path.join(dir,'north-seam-candidates.json'),rc.seamCandidateSource);
 for(const ref of spec.referenceArchives){const j=read(path.join(dir,ref.file));if(hash(zlib.gunzipSync(A.gitFile(c.head,ref.archive+'/diagnostic/look-report.json.gz')))!==(j.reference?.sha256??j.sha256))throw Error('Prior archive reference mismatch '+ref.file);if(j.sourceManifestSha256&&hash(A.gitFile(c.head,ref.archive+'/diagnostic/source-manifest.json'))!==j.sourceManifestSha256)throw Error('Prior source reference mismatch');}
};
