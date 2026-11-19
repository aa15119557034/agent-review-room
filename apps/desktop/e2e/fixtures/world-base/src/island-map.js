import { basins, contour } from './basins.js';

// The chart samples the playable heightfield. Lakes, rivers and tree patches use
// their scene coordinates, including the holes and point bars in the oxbow.
const W=960,H=588;
const marks=[
  ['alpine','双雪脊',1288,-468],['cascade','悬谷瀑布',622,-184],['sea-arch','潮门',-1888,-508],
  ['dunes','风纹沙岸',-1464,377],['woodland','山麓混交林',1063,436],['tarn','冰斗湖',735,-824],
  ['oxbow','东湾牛轭湖',1195,660],['station-street','桜ヶ丘车站',280,900],['ravines','赭土沟谷',1480,267],
  ['larkhaven','拉克港',-49,1046],['cairnwick','凯恩维克',180,-1238],['fields','原野农庄',-430,255],
];

function drawChart(canvas,island) {
  const h=island.heightAt;
  let west=Infinity,east=-Infinity,north=Infinity,south=-Infinity;
  for(let z=-3040;z<3072;z+=32)for(let x=-3040;x<3072;x+=32)if(h(x,z)>0){
    west=Math.min(west,x);east=Math.max(east,x);north=Math.min(north,z);south=Math.max(south,z);
  }
  const step=Math.max((east-west+380)/W,(south-north+300)/H);
  const x0=(west+east-W*step)/2,z0=(north+south-H*step)/2;
  const project=(x,z)=>[(x-x0)/step,(z-z0)/step];
  canvas.width=W;canvas.height=H;
  const ctx=canvas.getContext('2d'),image=ctx.createImageData(W,H),data=image.data;
  const tint=[[0,199,200,147],[85,152,176,128],[230,133,152,115],[365,174,161,126],[525,183,172,157],[630,229,226,208]];
  const last=new Float32Array(W);
  for(let j=0;j<H;j++){
    let prev=0;
    const z=z0+(j+0.5)*step;
    for(let i=0;i<W;i++){
      const x=x0+(i+0.5)*step,y=h(x,z),k=4*(j*W+i);
      const up=j?last[i]:y,left=i?prev:y;
      let r,g,b;
      if(y<=0){
        const shoal=Math.exp(Math.max(y,-65)*0.047);
        r=90+58*shoal;g=147+38*shoal;b=165+17*shoal;
      }else{
        let band=1;while(band<tint.length-1 && y>tint[band][0])band++;
        const a=tint[band-1],c=tint[band],t=Math.min(1,(y-a[0])/(c[0]-a[0]));
        const shade=Math.max(-31,Math.min(30,((up-y)*0.5+(left-y)*0.8)/step*33));
        const line=(Math.floor(y/40)!==Math.floor(left/40)||Math.floor(y/40)!==Math.floor(up/40))?9:0;
        r=a[1]+(c[1]-a[1])*t+shade-line;g=a[2]+(c[2]-a[2])*t+shade-line;b=a[3]+(c[3]-a[3])*t+shade-line;
        if(left<0||up<0){r=218;g=213;b=172;}
        for(const lake of basins){
          if(Math.abs(x-lake.x)<1.5*lake.rx&&Math.abs(z-lake.z)<1.5*lake.rz&&contour(lake,x,z)<1&&y<lake.level){
            r=87;g=148;b=165;break;
          }
        }
      }
      data[k]=r;data[k+1]=g;data[k+2]=b;data[k+3]=255;last[i]=y;prev=y;
    }
  }
  ctx.putImageData(image,0,0);
  ctx.fillStyle='rgba(42,86,58,0.29)';
  for(const t of island.woodland.trees){const [x,y]=project(t.x,t.z);ctx.fillRect(x,y,1.6,1.4);}
  ctx.strokeStyle='#5d9ba8';ctx.lineCap='round';
  for(const river of [island.river,...island.branches]){
    ctx.beginPath();river.rows.forEach((r,i)=>{const p=project(r.x,r.z);if(i===0)ctx.moveTo(...p);else ctx.lineTo(...p);});
    ctx.lineWidth=river===island.river?1.8:1.25;ctx.stroke();
  }
  ctx.fillStyle='#33525a';ctx.fillRect(28,H-32,500/step,2);
  ctx.font='13px sans-serif';ctx.fillText('500 m',28,H-39);
  return project;
}

export function installIslandMap(island,walker,select,currentView) {
  const dialog=document.querySelector('#island-map'),button=document.querySelector('#open-map');
  const canvas=dialog.querySelector('canvas'),pins=dialog.querySelector('.map-pins');
  let project,resume=false;
  function open(){
    if(!project){
      project=drawChart(canvas,island);
      for(const [id,name,x,z] of marks){
        const [u,v]=project(x,z),pin=document.createElement('button');
        pin.type='button';pin.textContent=name;pin.dataset.place=id;
        pin.style.left=u/W*100+'%';pin.style.top=v/H*100+'%';
        pin.addEventListener('click',()=>{resume=false;dialog.close();select(id);});
        pins.append(pin);
      }
    }
    for(const pin of pins.children)pin.setAttribute('aria-current',String(pin.dataset.place===currentView()));
    resume=walker.enabled;
    if(resume)walker.setEnabled(false);
    if(document.pointerLockElement)document.exitPointerLock();
    dialog.showModal();
  }
  dialog.addEventListener('close',()=>{if(resume)walker.setEnabled(true);resume=false;});
  dialog.querySelector('.map-close').addEventListener('click',()=>dialog.close());
  button.addEventListener('click',open);
  window.addEventListener('keydown',e=>{
    if(e.code==='KeyM' && !e.repeat){
      e.preventDefault();if(dialog.open)dialog.close();else open();
    }
  });
}
