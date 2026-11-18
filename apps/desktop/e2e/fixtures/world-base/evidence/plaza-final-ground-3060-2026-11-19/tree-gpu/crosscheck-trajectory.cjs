'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const base=process.argv[2]||__dirname;
const runs=['01-v2','02-final','03-final','04-v2'].flatMap(tag=>{const f=path.join(base,tag,'raw.json.gz');return fs.existsSync(f)?[{tag,data:JSON.parse(zlib.gunzipSync(fs.readFileSync(f)))}]:[];});
const norm=(a,b)=>Math.hypot(...a.map((x,j)=>x-b[j]));const q=(x,f)=>x.length?[...x].sort((a,b)=>a-b)[Math.max(0,Math.ceil(x.length*f)-1)]:null;
const brief=x=>({n:x.length,median:q(x,.5),p95:q(x,.95),max:q(x,1)});
const gcd=(a,b)=>b?gcd(b,a%b):a;const vec=x=>x.map(n=>Number(n.toFixed(7)));
const summary={interval:'[0.25,9.00] m from spawn, 0.08 m maximum Euclidean paired distance, no reused samples, greedy shortest-distance matching by observed pass or by RAF',runs:[],pairs:[]};
const dataByRun=new Map();
for(const {tag,data} of runs){
 const obj={tag,states:[],timers:[]};summary.runs.push(obj);dataByRun.set(tag,data);
 for(const {data:d} of data){
  const A=d.trials[0],T=d.trials[1];
  obj.states.push({mode:d.mode,Aeye:vec(A.start.eye),Aorientation:vec(A.start.orientation),Afeet:vec(A.start.feet),Aclock:A.start.clock,AtEnd:vec(A.end.eye),Afocus:[A.start.focus,A.end.focus],spawn:vec(T.start.feet),endFeet:vec(T.end.feet),Tfocus:[T.start.focus,T.end.focus],Tclock:T.start.clock});
  for(const t of d.trials){
   const single=t.samples.filter(s=>s.target!=='full'&&s.gpu.status==='valid').map(s=>Math.round(s.gpu.ms*1e6));
   if(single.length){
    const parts=['plaza/bark','plaza/blob','plaza/cards'],passes=['shadow0/map','world'];
    const submissionMismatches=[];
    for(const s of t.samples){for(const part of parts){for(const pass of passes){
      const raw=s.draws.filter(d=>d.pass===pass&&d.parts.includes(part)),expected=d.meta.find(x=>x.parts.includes(part));
      if(raw.length!==1||raw[0].draws!==1||!expected||expected.sourceCount!==1||raw[0].tri!==expected.tri)submissionMismatches.push([s.n,pass,part]);
    }}}
    const unexpectedPasses=[...new Set(t.samples.flatMap(s=>s.draws.filter(raw=>raw.parts.some(part=>parts.includes(part))&&!passes.includes(raw.pass)).map(raw=>raw.pass)))];
    obj.timers.push({label:t.label,samples:t.samples.length,submissionMismatches:submissionMismatches.length,unexpectedPasses,singleDrawQueries:single.length,distinctNonzero:[...new Set(single)].filter(x=>x!==0).length,zeroCount:single.filter(x=>!x).length,observedGcdNanoseconds:single.reduce(gcd,0),earliestTimestamp:t.samples[0].timestamp});
   }
  }
 }
}
for(const [v2Tag,newTag] of [['01-v2','02-final'],['04-v2','03-final']]){
 if(!dataByRun.has(v2Tag)||!dataByRun.has(newTag))continue;
 for(const mode of ['control','sparse']){
  const [,R,NN]=[0,dataByRun.get(v2Tag).find(x=>x.data.mode===mode),dataByRun.get(newTag).find(x=>x.data.mode===mode)];if(!R||!NN)continue;
  const old=R.data.trials[1],now=NN.data.trials[1],sameStart=norm(old.start.feet,now.start.feet);
  const chop=(tr,rows)=>rows.filter(row=>{const v=norm(tr.start.feet,row.feet);return v>=.25&&v<=9;});
  const match=(a,b)=>{const cand=[];for(const [i,u] of a.entries())for(const [j,v] of b.entries()){const delta=norm(u.feet,v.feet);if(delta<=.08)cand.push([i,j,delta]);}cand.sort((a,b)=>a[2]-b[2]);const used1=new Set(),used2=new Set(),chosen=[];for(const [i,j,distance] of cand){if(used1.has(i)||used2.has(j))continue;used1.add(i);used2.add(j);chosen.push([a[i].value,b[j].value,distance]);}return {v2:brief(chosen.map(x=>x[0])),final:brief(chosen.map(x=>x[1])),pairedDelta:brief(chosen.map(x=>x[1]-x[0])),distance:brief(chosen.map(x=>x[2]))};};
  const rf=r=>chop(r,r.frames.map(x=>({feet:x.slice(2,5),value:x[1]}))),sf=(r,k)=>chop(r,r.samples.filter(x=>x.target===k&&x.gpu.status==='valid').map(x=>({feet:x.feet,value:x.gpu.ms})));
  const byKey={};for(const k of new Set([...old.samples,...now.samples].map(x=>x.target)))byKey[k]=match(sf(old,k),sf(now,k));
  summary.pairs.push({v2Tag,newTag,mode,sameStartM:sameStart,endDifferenceM:norm(old.end.feet,now.end.feet),raf:match(rf(old),rf(now)),byKey});
 }
}
fs.writeFileSync(path.join(base,'crosscheck-trajectory.json'),JSON.stringify(summary,null,2)+'\n');
for(const o of summary.runs)console.log(o.tag,'gcd/zero/total',o.timers.map(t=>[t.observedGcdNanoseconds,t.zeroCount,t.singleDrawQueries]),'A eye(s)',o.states.map(x=>x.Aeye.join(',')).join(' | '));
for(const c of summary.pairs){console.log(c.v2Tag,c.newTag,c.mode,'endpoint',c.endDifferenceM.toFixed(3),'paired RAF',c.raf.v2.n,'P95 ms',c.raf.v2.p95,c.raf.final.p95,'valid GPU matched by key',Object.entries(c.byKey).map(([k,v])=>[k,v.v2.n]));}
