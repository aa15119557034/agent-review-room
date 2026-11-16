import * as T from 'three';

export function neighborhood(c){
  const {root,box,cylinder,rod,tube,mesh,group,toon,glow,canvasTexture}=c;
  const wood=toon('#7c625e'),dark=toon('#34334b'),steel=toon('#66788a'),stone=toon('#78848d');
  // A cropped neighbouring home gives the back corner a readable second layer.
  const home=group('neighbor-house-corner',5.55,.07,-6.0);
  box(2.4,.18,1.68,0,.09,0,stone,home,.04);
  box(2.33,2.57,1.56,0,1.46,0,toon('#a69a9a'),home,.025);
  for(let i=0;i<12;i++)box(.17,.75,.055,-1.05+i*.19,.56,.80,wood,home,.008);
  for(const x of [-1.18,1.18])box(.09,2.64,.075,x,1.48,.81,dark,home,.012);
  box(1.32,1.08,.095,-.12,1.83,.82,wood,home,.018);
  box(1.15,.89,.025,-.12,1.83,.878,glow('#f6d59f',.80),home,.008);
  for(const x of [-.69,-.12,.45])box(.035,.97,.035,x,1.83,.90,dark,home,.003);
  for(const y of [1.40,1.82,2.26])box(1.21,.035,.035,-.12,y,.90,dark,home,.003);
  for(let i=0;i<10;i++)box(1.12,.016,.018,-.12,1.45+i*.077,.915,toon('#c3ab91',.10),home,0);
  box(1.43,.09,.23,-.12,1.26,.91,wood,home,.012);
  for(let i=0;i<12;i++)box(.17,.75,.055,-1.05+i*.19,.56,-.80,wood,home,.008);
  box(.95,.73,.055,.18,1.87,-.81,dark,home,.02);
  box(.83,.61,.018,.18,1.87,-.848,toon('#8a9ba8',.08),home,.008);
  for(const x of [-.21,.18,.57])box(.024,.64,.020,x,1.87,-.865,dark,home,.003);
  box(1.10,.08,.20,.18,2.30,-.84,steel,home,.012);
  box(2.55,.11,1.78,0,2.78,0,dark,home,.02);
  for(const side of [-1,1]){
    const roof=box(2.64,.08,1.02,0,2.99,side*.43,toon('#52647a'),home,.025);roof.rotation.x=side*.36;
    for(let i=0;i<15;i++)tube([[-1.22+i*.174,2.83,side*.91],[-1.22+i*.174,3.02,side*.46],[-1.22+i*.174,3.21,0]],.018,steel,home,8);
  }
  box(2.71,.10,.12,0,3.22,0,steel,home,.028);
  tube([[1.22,2.73,.80],[1.28,2.6,.83],[1.28,.16,.83]],.034,steel,home);
  // Low boundary, stepping stones and planted corner leave the road usable.
  const garden=group('neighbor-garden',5.80,.07,-4.43);
  box(1.91,.17,1.17,0,.085,0,stone,garden,.04);
  box(1.73,.04,1.00,0,.19,0,toon('#3d4548'),garden,.03);
  for(const x of [-.94,.94])box(.12,.29,1.18,x,.17,0,wood,garden,.016);
  box(1.94,.29,.12,0,.17,.54,wood,garden,.016);
  for(let i=0;i<5;i++)box(.35,.035,.32,4.17,.08,-4.8+i*.33,toon(i%2?'#91979e':'#788894'),root,.045);
  for(let i=0;i<13;i++){
    const x=4.62+i*.17;box(.105,.76,.07,x,.48,-5.01,wood,root,.018);
  }
  for(const y of [.28,.67])box(2.19,.055,.08,5.64,y,-5.055,dark,root,.01);
  const tree=group('rainy-neighborhood-tree',.16,.22,-.05,garden);
  const bark=toon('#6c5855');tube([[0,0,0],[.05,.72,.02],[-.09,1.28,0],[.02,1.95,.04]],.082,bark,tree,18);
  for(let i=0;i<7;i++){const a=i*2.4;rod([0,.82+i*.10,0],[Math.cos(a)*.42,1.75+i*.09,Math.sin(a)*.35],.027,bark,tree);}
  const leaves=['#4e7779','#6a8c87','#577e83','#759995'].map(color=>toon(color));
  for(let i=0;i<48;i++){
    const a=i*2.3999,r=.18+.48*Math.sqrt((i%13)/13),y=1.93+Math.sin(i*1.7)*.34;
    const leaf=mesh(new T.SphereGeometry(.23,18,12),leaves[i%4],[Math.cos(a)*r,y,Math.sin(a)*r*.72],tree);
    leaf.scale.set(1,.72,1.18);leaf.rotation.y=a;
  }
  for(let i=0;i<9;i++){const bush=mesh(new T.SphereGeometry(.23,16,12),leaves[(i+1)%4],[-.68+i*.16,.42,.28],garden);bush.scale.set(1,.8,.85);}
  // A slim illuminated pylon balances the utility poles without covering glass.
  const pylon=group('convenience-store-pylon',-6.03,.07,4.55);
  box(.62,.15,.46,0,.075,0,stone,pylon,.055);
  for(const x of [-.19,.19]){box(.085,3.82,.085,x,1.99,0,steel,pylon,.018);cylinder(.05,.05,.035,x,.17,.12,dark,pylon,16);}
  box(1.12,1.80,.28,0,4.38,0,toon('#386a78'),pylon,.07);
  const face=canvasTexture(512,896,(g,w,h)=>{
    g.fillStyle='#e4eef0';g.fillRect(0,0,w,h);g.fillStyle='#32696d';g.fillRect(0,0,w,78);g.fillRect(0,h-170,w,170);
    g.fillStyle='#315567';g.textAlign='center';g.textBaseline='middle';g.font='700 126px "Yu Gothic",Meiryo,sans-serif';
    [...'雨あかり'].forEach((ch,i)=>g.fillText(ch,w/2,157+i*155));
    g.fillStyle='#e4eef0';g.font='700 76px sans-serif';g.fillText('24 H',w/2,h-82);
  });
  const lightboxFace=new T.MeshBasicMaterial({map:face,color:new T.Color().setScalar(1.45),toneMapped:false});
  for(const side of [-1,1]){const panel=mesh(new T.PlaneGeometry(.98,1.64),lightboxFace,[0,4.38,side*.148],pylon);if(side<0)panel.rotation.y=Math.PI;}
  box(.93,.04,.16,0,5.30,0,glow('#d4e9ff',2.05),pylon,.01);
  tube([[.22,.15,-.05],[.22,3.55,-.05],[0,3.63,-.12]],.014,dark,pylon);
}
