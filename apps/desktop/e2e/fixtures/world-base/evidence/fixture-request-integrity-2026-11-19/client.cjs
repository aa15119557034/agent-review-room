async function run() {
  const T=await import('three'), records=[], responses=[], aborts=[];
  const realFetch=window.fetch;
  window.fetch=async function(...args) {
    const req=args[0], url=new URL(typeof req==='string'?req:req.url,location.href);
    const res=await realFetch.apply(this,args);
    if(url.searchParams.has('case')){
      const id=res.headers.get('X-Transport-Receipt');
      const signal=args[1]?.signal||req.signal;
      responses.push({url:url.pathname+url.search,id,status:res.status,range:res.headers.get('Content-Range'),length:+res.headers.get('Content-Length')});
      if(signal)signal.addEventListener('abort',()=>aborts.push(id),{once:true});
    }
    return res;
  };
  const sha=async data=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const paths=['/assets/models/menhir.glb','/mature-sakura/mature-sakura.glb','/prop-assets/plastic_crate_02/plastic_crate_02_1k.gltf','/prop-assets/plastic_crate_02/plastic_crate_02.bin'];
  async function request(mode,url,progressLog,controls={}) {
    if(mode==='three'){
      const loader=new T.FileLoader(new T.LoadingManager()).setResponseType('arraybuffer');
      const progress=ev=>{progressLog.push([ev.loaded,ev.total]);if(controls.abort && progressLog.length===1)loader.abort();};
      return loader.loadAsync(url,progress);
    }
    const ctl=new AbortController(),req=new Request(url,{signal:ctl.signal,credentials:'same-origin',cache:'default',priority:'auto'});
    const response=await fetch(req);
    if(!response.ok)throw Error('HTTP '+response.status);
    if(controls.abort){const pending=response.arrayBuffer();ctl.abort();return pending;}
    if(mode==='raw')return response.arrayBuffer();
    const reader=response.body.getReader(),chunks=[];
    if(mode==='reader'){
      let length=0;
      for(;;){const v=await reader.read();if(v.done)break;chunks.push(v.value);length+=v.value.length;}
      const result=new Uint8Array(length);let offset=0;
      for(const k of chunks){result.set(k,offset);offset+=k.length;}
      return result.buffer;
    }
    return new Response(new ReadableStream({start(controller){
      function pump(){reader.read().then(({done,value})=>{if(done){controller.close();if(mode==='keep')window.__lastReceipt=response.headers.get('X-Transport-Receipt');}else{controller.enqueue(value);pump();}},e=>controller.error(e));}
      pump();
    }})).arrayBuffer();
  }
  async function test(mode,url,controls={}) {
    const progress=[];
    try{
      const bytes=await request(mode,url,progress,controls);
      records.push({mode,url,resolved:true,length:bytes.byteLength,sha:await sha(bytes),progress});
    }catch(e){records.push({mode,url,resolved:false,error:e.name+': '+e.message,progress});}
  }
  // Equal real request options across native cases; interleave URL, request mode and run order.
  const modes=['raw','reader','rewrap','keep','three'];
  for(let turn=0;turn<10;turn++)for(const [i,path] of paths.entries())for(let k=0;k<modes.length;k++){
    const mode=modes[(k+turn+i)%modes.length];await test(mode,path+'?case=normal-'+turn+'-'+mode);
  }
  for(const mode of ['raw','three'])for(const control of ['short','wrong','abort','missing'])
    await test(mode,paths[3]+'?case='+control+'-'+mode,{abort:control==='abort'});
  const shared=paths[0]+'?case=three-coalesced';
  await Promise.all([test('three',shared),test('three',shared)]);
  const twin=paths[3]+'?case=same-url-twin';
  // Address each response independently even though both requests have exactly the same URL.
  const twins=await Promise.all([1,2].map(async n=>{
    const r=await fetch(twin,{cache:'no-store',headers:{'X-Audit-Twin':String(n)}}),bytes=await r.arrayBuffer();
    return {call:n,id:r.headers.get('X-Transport-Receipt'),length:bytes.byteLength,sha:await sha(bytes)};
  }));
  return {records,responses,aborts,twins};
}
