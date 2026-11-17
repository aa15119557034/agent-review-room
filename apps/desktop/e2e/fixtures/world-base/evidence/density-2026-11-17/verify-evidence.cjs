// Read-only archive verifier. No Git, network, scene or GPU. Optional report lives outside the archive.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const [directory,output]=process.argv.slice(2);
if(!directory){console.log('node x51-verify-evidence.cjs <evidence-directory> [external-report.json]');process.exit(0);}
const root=fs.realpathSync(directory),relative=p=>path.relative(root,p);
function contained(p){const r=relative(p);return r!==''&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);}
const provenance=JSON.parse(fs.readFileSync(path.join(root,'provenance.json'),'utf8'));
const failures=[],records=[],links=[];const names=new Set();
for(const entry of provenance.files){
 if(typeof entry.file!=='string'||entry.file.includes('\\')||entry.file.split('/').some(s=>!s||s==='.'||s==='..')){failures.push('Invalid path '+entry.file);continue;}
 if(names.has(entry.file))failures.push('Duplicate '+entry.file);names.add(entry.file);
 const file=path.join(root,entry.file);
 if(!fs.existsSync(file)){failures.push('Missing '+entry.file);continue;}
 if(!contained(fs.realpathSync(file))){failures.push('Escaped archive '+entry.file);continue;}
 const bytes=fs.readFileSync(file),actual=sha(bytes),ok=bytes.length===entry.bytes&&actual===entry.sha256;
 records.push({file:entry.file,bytes:bytes.length,sha256:actual,ok});if(!ok)failures.push('Bytes/hash '+entry.file);
 if(entry.losslessGzip){try{const raw=zlib.gunzipSync(bytes);if(raw.length!==entry.originalBytes||sha(raw)!==entry.originalSha256)failures.push('Gzip original mismatch '+entry.file);}catch(e){failures.push('Invalid gzip '+entry.file+': '+e.message);}}
 if(entry.file.endsWith('.md'))for(const match of bytes.toString('utf8').matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)){
   const target=match[1].split(/\s+"/)[0].replace(/^<|>$/g,'');if(/^(?:[a-z]+:|#)/i.test(target))continue;
   const local=decodeURIComponent(target.split('#')[0]);if(!local)continue;
   const resolved=path.resolve(path.dirname(file),local),exists=fs.existsSync(resolved);links.push({file:entry.file,target,exists});if(!exists)failures.push('Broken local link '+entry.file+' -> '+target);
 }
}
function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,item.name);if(item.isSymbolicLink()){failures.push('Unexpected symlink '+relative(p));continue;}if(item.isDirectory())walk(p);else{const r=relative(p).replaceAll('\\','/');if(r!=='provenance.json'&&!names.has(r))failures.push('Unlisted file '+r);}}}walk(root);
const result={createdAt:new Date().toISOString(),root,head:provenance.head,ok:failures.length===0,inventoryCount:provenance.files.length,filesVerified:records.length,losslessGzipCount:provenance.files.filter(e=>e.losslessGzip).length,localLinkCount:links.length,failures,records,links,scope:'Size/SHA256 for every inventory entry, gzip original bytes/SHA, extra-file and local Markdown-link checks. provenance.json is not self-authenticating; exact Git/source validation remains curator responsibility. No visual/numeric meaning or remote link availability is inferred.'};
if(output){const out=path.resolve(output);if(contained(out)||out===root)throw Error('Report must be outside archive');fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({ok:result.ok,head:result.head,files:records.length,gzip:result.losslessGzipCount,links:links.length,failures},null,2));if(!result.ok)process.exitCode=1;
