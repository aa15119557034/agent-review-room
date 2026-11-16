import * as T from 'three';

export function serviceAlley(c){
  const {root,group,box,cylinder,sphere,tube,rod,mesh,toon,label}=c;
  const steel=toon('#7f94a0'),iron=toon('#334457'),mint=toon('#618e88'),paper=toon('#b09a7f'),tape=toon('#ccba97');
  const warmLight=new T.PointLight('#ffd298',3.6,4.6,1.8);warmLight.position.set(-.15,2.95,-5.48);root.add(warmLight);
  // Folded delivery crates stay beside the door, outside its walking space.
  const crates=group('folded-delivery-crates',.70,.28,-5.30);
  for(let level=0;level<4;level++){
    const y=.045+level*.11;box(.48,.035,.42,0,y,0,mint,crates,.008);
    for(const z of [-.195,.195]){box(.49,.07,.025,0,y+.04,z,mint,crates,.005);for(let i=0;i<5;i++)box(.025,.055,.029,-.20+i*.10,y+.04,z,iron,crates,.003);}
    for(const x of [-.225,.225])box(.025,.07,.42,x,y+.04,0,mint,crates,.005);
  }
  function carton(parent,x,y,z,w,h,d,rot=0){
    const g=group('delivery-cardboard-box',x,y,z,parent);g.rotation.y=rot;
    box(w,h,d,0,h/2,0,paper,g,.015);
    box(.065,.009,d+.006,0,h+.006,0,tape,g,.002);box(.065,h*.36,.009,0,h*.82,-d/2-.007,tape,g,.002);
    box(w*.89,.005,.009,0,h+.008,0,iron,g,0);
    const face=label('↑ ↑',w*.38,h*.26,0,h*.5,-d/2-.013,{parent:g,font:110,bg:'#b09a7f',fg:'#5d584f'});face.rotation.y=Math.PI;
    return g;
  }
  const stack=group('alley-cardboard-stack',-2.49,.28,-5.22);
  carton(stack,0,0,0,.68,.43,.51);carton(stack,.07,.44,-.035,.55,.31,.43,.08);
  const flattened=group('flattened-cardboard',-3.10,.28,-5.05);
  for(let i=0;i<6;i++)box(.45,.022,.53,(i%2)*.02,.02+i*.026,0,paper,flattened,.007);
  box(.052,.17,.55,.02,.085,0,tape,flattened,.004);
  // Small delivery dolly: caster wheels, tray, load and bent handle.
  const cart=group('delivery-handcart',-3.85,.28,-5.86);cart.rotation.y=-.12;
  for(const x of [-.31,.31])for(const z of [-.23,.23]){
    const wheel=cylinder(.082,.082,.055,x,.082,z,iron,cart,20);wheel.rotation.z=Math.PI/2;
    box(.08,.08,.07,x,.16,z,steel,cart,.01);
  }
  box(.83,.09,.64,0,.23,0,mint,cart,.028);box(.71,.015,.52,0,.285,0,iron,cart,.008);
  tube([[-.34,.26,-.25],[-.34,1.07,-.34],[-.27,1.16,-.34],[.27,1.16,-.34],[.34,1.07,-.34],[.34,.26,-.25]],.022,steel,cart,24);
  rod([-.23,1.16,-.34],[.23,1.16,-.34],.032,iron,cart);
  carton(cart,-.02,.30,.015,.62,.41,.46,.03);
  // A draped cord net covers tied refuse bags rather than an empty generic box.
  const trash=group('bird-net-refuse-area',-4.94,.28,-5.61);trash.rotation.y=Math.PI;
  box(1.02,.045,1.09,0,.023,0,iron,trash,.035);
  const bags=[toon('#a7b5b3'),toon('#8c9eab'),toon('#c1c1ad')];
  for(let i=0;i<5;i++){
    const x=(i%3-1)*.27,z=-.20+Math.floor(i/3)*.38;
    const bag=mesh(new T.SphereGeometry(1,20,14),bags[i%3],[x,.24,z],trash);bag.scale.set(.19,.23,.19);bag.rotation.z=(i-2)*.05;
    cylinder(.027,.065,.06,x,.47,z,bags[i%3],trash,12);box(.07,.018,.045,x,.51,z,iron,trash,.008);
  }
  const net=toon('#5e8a80');
  const height=(x,z)=>.10+.49*Math.sqrt(Math.max(0,1-(x/.57)**2-(z/.61)**2));
  for(let line=0;line<11;line++){
    const a=-.5+line*.1,alongX=[],alongZ=[];
    for(let p=0;p<=16;p++){const b=-.54+p*.0675;alongX.push([a,height(a,b),b]);alongZ.push([b,height(b,a),a]);}
    tube(alongX,.0065,net,trash,24);tube(alongZ,.0065,net,trash,24);
  }
  label('可燃',.29,.15,0,.16,.56,{parent:trash,font:130,bg:'#799c87',fg:'#e0e5d5'});
  // Gas meter and its connected pipes are legible beside the warm service door.
  const gas=group('rear-gas-meter',-1.55,.28,-4.94);gas.rotation.y=Math.PI;
  box(.36,.48,.20,0,1.22,0,steel,gas,.045);box(.25,.12,.016,0,1.33,.11,toon('#d3d9c4'),gas,.012);
  label('00318',.20,.075,0,1.33,.122,{parent:gas,font:110,bg:'#c5cbb8',fg:'#405058'});
  for(const side of [-1,1])tube([[side*.11,1.43,0],[side*.11,1.64,0],[side*.28,1.64,0],[side*.28,.20,0]],.025,steel,gas,16);
  for(const y of [.42,.95,1.50])box(.68,.04,.06,0,y,-.04,iron,gas,.008);
  cylinder(.07,.07,.024,-.28,.68,.04,toon('#a8695e'),gas,16).rotation.x=Math.PI/2;
  const pipe=group('rear-rain-downpipe',-1.03,.28,-4.96);
  tube([[0,3.1,0],[0,2.95,0],[0,.22,0],[-.05,.10,-.12]],.035,steel,pipe,32);
  for(const y of [.40,1.40,2.50])box(.12,.045,.09,0,y,.01,iron,pipe,.006);
  box(.30,.015,.30,-.08,.015,-.15,iron,pipe,.018);
  for(let i=0;i<6;i++)box(.014,.009,.25,-.19+i*.044,.027,-.15,steel,pipe,.002);
  return {warmLight};
}
