// Verify the uncompressed HTTP bytes separately, through the production fixture server.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const fixture=path.resolve(__dirname,'../../..'),{createStaticServer}=require(path.join(fixture,'scripts/baseline.cjs'));
(async()=>{
  const server=createStaticServer(fixture);
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const result={};
  try {
    for(const profile of ['afternoon','evening']) {
      const folder=profile==='afternoon'?'street-env':'street-env-evening';result[profile]=[];
      for(const face of ['px','nx','py','ny','pz','nz']) {
        const pathname='/src/'+folder+'/'+face+'.png',res=await fetch('http://127.0.0.1:'+server.address().port+pathname);
        const bytes=Buffer.from(await res.arrayBuffer());
        assert.equal(res.status,200);assert.equal(+res.headers.get('content-length'),bytes.length);
        assert.deepEqual(bytes,fs.readFileSync(path.join(fixture,pathname.slice(1))));
        result[profile].push({face,pathname,http:res.status,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
      }
    }
  }finally{server.close();}
  fs.writeFileSync(path.join(__dirname,'http-bytes.json'),JSON.stringify(result,null,2)+'\n');
  console.log('12 HTTP bodies byte-identical to installed PNGs.');
})().catch(e=>{console.error(e);process.exitCode=1});
