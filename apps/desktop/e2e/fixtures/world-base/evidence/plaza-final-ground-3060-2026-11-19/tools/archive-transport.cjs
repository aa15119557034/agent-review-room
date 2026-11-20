'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), z=require('node:zlib');
const [reportFile,out]=process.argv.slice(2);
if (!reportFile || !out) throw Error('Pass raw native report and new .json.gz path.');
const raw=JSON.parse(fs.readFileSync(reportFile));
const a=raw.transportAudit;
assert(a && a.payloadIntegrityClean && !a.problems.length);
const ids=new Map(a.requests.map((r,i)=>[r.requestId,'request-'+(i+1)]));
const tokens=new Map(a.served.map((r,i)=>[r.receipt,'transfer-'+(i+1)]));
assert.equal(ids.size,a.requests.length);assert.equal(tokens.size,a.served.length);
for(const row of a.served){
    const browser=a.requests.filter(r=>r.receipt===row.receipt);
    assert.equal(browser.length,1);const c=browser[0],u=new URL(c.url);
    assert(/^https?:$/.test(u.protocol));assert.equal(row.path,u.pathname+u.search);
    assert.equal(row.method,c.method);assert.equal(row.status,c.status);
    assert.equal(row.finished,true);assert.equal(row.fileBytes,row.wireBytes);
    assert.equal(row.sha256,row.wireSHA256);assert.match(row.sha256,/^[a-f0-9]{64}$/);
}
const http=a.requests.filter(r=>/^https?:/.test(r.url));
assert.equal(http.length,a.served.length);
assert(http.every(c=>tokens.has(c.receipt)));
for(const row of a.reads){
    const served=a.served.find(r=>r.receipt===row.receipt);
    assert(served, row.path);assert(row.done && !row.aborted && !row.readError);
    assert.equal(row.received,served.fileBytes);assert.equal(row.sha256,served.sha256);
}
for(const e of a.verifiedCanceled){
    const c=a.requests.find(x=>x.requestId===e.requestId);
    assert.equal(c.receipt,e.receipt);assert.equal(c.terminal,'failed');
    assert.equal(a.reads.filter(x=>x.receipt===e.receipt).length,1);
}
const summary={rawCDPClean:a.strictTransportClean,payloadIntegrityClean:a.payloadIntegrityClean,originHTTP:http.length,sourceToWireMatched:a.served.length,applicationBodyReceipts:a.reads.length,browserBlobs:a.requests.length-http.length,verifiedCanceled:a.verifiedCanceled.length,unresolved:a.problems.length};
function sanitize(key,value){
    if(key==='requestId')return ids.get(value)??value;
    if(key==='receipt')return tokens.get(value)??value;
    if(key==='url' && typeof value==='string'){const u=new URL(value);return u.protocol==='blob:'?'blob:fixture':u.pathname+u.search;}
    return value;
}
fs.writeFileSync(out,z.gzipSync(Buffer.from(JSON.stringify({summary,audit:a},sanitize)+'\n'),{level:9}));
console.log(path.basename(out),summary);
