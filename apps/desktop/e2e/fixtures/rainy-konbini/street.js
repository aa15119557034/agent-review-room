import * as T from 'three';
import { neighborhood } from './neighborhood.js';

export function buildStreet(c) {
  const {root,box,cylinder,sphere,tube,rod,group,toon,glow,label,poster,mesh,canvasTexture}=c;
  const iron=toon('#293e50'), steel=toon('#6b868d'), cream=toon('#c4c4ad'), yellow=toon('#c8a668'), red=toon('#b7594e'), mint=toon('#60958b'), dark=toon('#182632'), rubber=toon('#1a2533');
  const base=group('square-collectible-base');
  box(14,.20,14,0,-.62,0,toon('#62575e'),base,.12);
  box(13.86,.38,13.86,0,-.33,0,toon('#7a686b'),base,.065);
  box(13.98,.14,13.98,0,-.07,0,toon('#30374e'),base,.065);
  for(const z of [-6.94,6.94])box(13.80,.025,.025,0,-.54,z,toon('#a18b85'),base,.006);
  for(const x of [-6.94,6.94])box(.025,.025,13.80,x,-.54,0,toon('#a18b85'),base,.006);
  for(let i=0;i<28;i++){
    const x=-6.55+i*.48,y=-.23-(i%3)*.075;
    box(.10+(i%4)*.025,.033,.025,x,y,6.938,toon(i%2?'#9b8a86':'#5d5864'),base,.012);
    box(.025,.033,.10+(i%4)*.025,6.938,y,x,toon(i%2?'#8e7c79':'#5d5864'),base,.012);
  }
  box(13.94,.045,13.94,0,.01,0,toon('#33495d'),base,.06);
  box(13.7,.035,.055,0,-.21,6.97,toon('#607a8b'),base,.01);
  const asphalt=canvasTexture(1024,1024,(g,w,h)=>{
    g.fillStyle='#364554';g.fillRect(0,0,w,h);let seed=17;const rand=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
    for(let n=0;n<24000;n++){const v=rand()>.5?105:35;g.fillStyle=`rgba(${v},${v+15},${v+25},.16)`;g.fillRect(rand()*w,rand()*h,1+rand()*2,1+rand()*2);}
    g.strokeStyle='rgba(13,26,39,.27)';g.lineWidth=2;for(let n=0;n<14;n++){let x=rand()*w,y=rand()*h;g.beginPath();g.moveTo(x,y);for(let i=0;i<5;i++){x+=rand()*75-20;y+=rand()*35-15;g.lineTo(x,y);}g.stroke();}
  });
  const roadmat=new T.MeshToonMaterial({map:asphalt,color:'#aebccb',gradientMap:toon('#ffffff').gradientMap});
  box(13.88,.025,13.88,0,.044,0,roadmat,root,0);
  box(9.7,.21,9.65,-1.55,.14,-1.7,toon('#819292'),root,.055);
  const pave=[toon('#879b9b'),toon('#91a4a3'),toon('#7f9395')];pave.forEach(mat=>mat.userData.inkWeight=.08);
  for(let ix=0;ix<22;ix++)for(let iz=0;iz<22;iz++){
    const x=-6.15+ix*.438,z=-6.26+iz*.438;
    if(x>-5.85&&x<1.96&&z>-4.96&&z<1.45)continue;
    box(.423,.025,.423,x,.26,z,pave[(ix*17+iz*7)%3],root,.006);
  }
  for(let i=0;i<23;i++)box(.406,.14,.25,-6.18+i*.42,.17,3.11,cream,root,.018);
  for(let i=0;i<23;i++)box(.25,.14,.406,3.35,.17,-6.2+i*.42,cream,root,.018);
  // Tactile paving follows the doorway and bends around the street corner.
  for(let i=0;i<12;i++){
    const g=group('tactile-paving',-1.25+i*.34,.28,2.55);box(.32,.022,.32,0,0,0,yellow,g,.007);
    for(let k=0;k<4;k++)box(.024,.012,.27,-.105+k*.07,.017,0,toon('#ddc482'),g,.004);
  }
  for(let i=0;i<6;i++)box(2.2,.009,.38,-3.6,.064,3.65+i*.52,toon('#b9ccc8'),root,.012);
  for(let i=0;i<5;i++)box(.085,.009,.70,5.15,.065,-3.7+i*1.9,toon('#c4b68a'),root,.008);
  const park=group('parking-bay',4.05,.066,-1.1);
  for(const x of [-.6,.6])box(.035,.008,2.4,x,0,0,cream,park,0);box(1.25,.008,.035,0,0,-1.2,cream,park,0);
  const p=label('P',.45,.55,0,.008,0,{parent:park,font:110,bg:'#364554',fg:'#c4c4ad'});p.rotation.x=-Math.PI/2;
  for(const x of [-.34,.34]){box(.43,.11,.15,x,.045,-.94,cream,park,.035);box(.15,.013,.13,x,.106,-.94,yellow,park,.006);}
  // Recessed drainage slots and concentric iron manhole rings.
  for(let i=0;i<8;i++){
    const x=-5.4+i*1.02;box(.76,.025,.16,x,.071,3.34,dark,root,.01);for(let k=0;k<12;k++)box(.017,.016,.15,x-.34+k*.061,.087,3.34,steel,root,0);
  }
  for(let i=0;i<6;i++){box(.16,.025,.76,3.56,.072,-5.6+i*1.37,dark);for(let k=0;k<12;k++)box(.15,.016,.017,3.56,.088,-5.94+i*1.37+k*.061,steel,root,0);}
  const manhole=group('cast-iron-manhole',2.2,.065,5.35);
  cylinder(.5,.5,.025,0,0,0,iron,manhole,64);
  for(const r of [.42,.32]){const ring=mesh(new T.TorusGeometry(r,.008,6,64),steel,[0,.016,0],manhole);ring.rotation.x=Math.PI/2;}
  for(let i=-3;i<=3;i++){box(.02,.009,.45,i*.08,.02,0,steel,manhole,0);box(.45,.009,.02,0,.02,i*.08,steel,manhole,0);}
  // Guardrails frame the miniature without blocking the shopfront.
  for(const [x,z,rot]of[[-5.6,3.0,0],[1.75,3.0,0],[3.18,-4.85,Math.PI/2]]){
    const g=group('street-guardrail',x,.24,z);g.rotation.y=rot;
    for(const side of [-.62,.62]){cylinder(.055,.065,.77,side,.39,0,cream,g,16);cylinder(.09,.09,.05,side,.035,0,iron,g,16);}
    tube([[-.62,.75,0],[-.58,.86,0],[.58,.86,0],[.62,.75,0]],.045,cream,g);
    rod([-.62,.32,0],[.62,.32,0],.035,cream,g);
  }
  function vendingMachine(x,index){
  const vending=group('illuminated-vending-machine',x,.27,-5.62);vending.rotation.y=Math.PI;
  box(1.03,2.05,.78,0,1.03,0,index?mint:red,vending,.065);box(.84,1.29,.022,-.035,1.29,.405,dark,vending,.02);
  box(.71,1.15,.015,-.09,1.30,.425,glow('#badce0',.72),vending,.012);
  for(let row=0;row<4;row++)for(let col=0;col<4;col++){
    const x=-.35+col*.17,y=.88+row*.26;
    cylinder(.047,.05,.14,x,y,.48,toon(['#c76c58','#ddc56b','#678b98','#68a895'][col],.35),vending,14);
    cylinder(.031,.031,.024,x,y+.082,.48,cream,vending,10);box(.085,.028,.022,x,y-.12,.48,glow('#c9d8d4',.6),vending,.005);
  }
  box(.73,.17,.12,-.04,.40,.43,dark,vending,.025);box(.44,.05,.04,-.1,.47,.50,steel,vending,.007);
  box(.13,.31,.05,.40,.92,.45,iron,vending,.01);cylinder(.03,.03,.035,.4,1.02,.49,yellow,vending,16).rotation.x=Math.PI/2;
  label(index?'HOT & COLD':'つめたい',.74,.17,-.03,1.99,.414,{parent:vending,bg:'#295f70',fg:'#e6f2da',font:105,lit:true});
  }
  vendingMachine(1.54,0);vendingMachine(2.66,1);
  const vendingLight=new T.PointLight('#8cdbdf',3,5,1.9);vendingLight.position.set(2.1,1.4,-6.2);root.add(vendingLight);
  // Bins, umbrellas and a detailed bicycle.
  const bins=group('recycling-bins',-5.95,.28,.20);
  for(let i=0;i<2;i++){cylinder(.23,.22,.7,0,.35,-i*.57,toon(i?'#66877e':'#aab5ac'),bins,24);cylinder(.25,.25,.09,0,.73,-i*.57,cream,bins,24);box(.25,.085,.02,0,.63,.235-i*.57,dark,bins,.02);label(i?'缶':'PET',.16,.12,0,.44,.229-i*.57,{parent:bins,font:130});}
  const rack=group('umbrella-stand',.65,.28,1.84);box(.57,.11,.37,0,.08,0,iron,rack,.02);
  for(const x of [-.26,.26])for(const z of [-.16,.16])rod([x,.1,z],[x,.62,z],.018,steel,rack);
  for(const y of [.18,.60]){rod([-.26,y,-.16],[.26,y,-.16],.018,steel,rack);rod([-.26,y,.16],[.26,y,.16],.018,steel,rack);}
  for(let i=0;i<4;i++){
    const x=-.20+i*.13;rod([x,.12,0],[x+.05,.92,0],.013,steel,rack);
    const cloth=cylinder(.045,.009,.57,x+.02,.43,0,toon(['#617e98','#a0b5ac','#ac7d79','#bcb5a2'][i]),rack,12);cloth.rotation.z=-.06;
    tube([[x+.05,.91,0],[x+.08,1.02,0],[x+.17,1.0,0],[x+.18,.94,0]],.021,wood(),rack,12);
  }
  function wood(){return toon('#9b775c');}
  function bicycle(x,z,rot){
    const g=group('bicycle',x,.29,z);g.rotation.y=rot;const frame=toon('#77a69c');
    for(const wx of [-.66,.66]){
      mesh(new T.TorusGeometry(.34,.038,12,64),rubber,[wx,.37,0],g);
      mesh(new T.TorusGeometry(.30,.012,8,64),steel,[wx,.37,0],g);
      for(let i=0;i<20;i++){const a=i*Math.PI/10;rod([wx,.37,0],[wx+Math.cos(a)*.30,.37+Math.sin(a)*.30,.006],.0045,steel,g);}
      cylinder(.035,.035,.16,wx,.37,0,iron,g,12).rotation.x=Math.PI/2;
    }
    for(const [a,b]of[[[-.66,.37,0],[-.22,.88,0]],[[-.22,.88,0],[.08,.38,0]],[[.08,.38,0],[-.66,.37,0]],[[-.22,.88,0],[.46,.91,0]],[[.46,.91,0],[.08,.38,0]],[[.46,.91,0],[.66,.37,0]]])rod(a,b,.023,frame,g);
    rod([-.22,.88,0],[-.25,1.02,0],.018,steel,g);box(.29,.055,.16,-.27,1.04,0,toon('#8b6352'),g,.025);
    tube([[.46,.91,0],[.43,1.16,0],[.50,1.22,.23]],.017,steel,g);rod([.49,1.22,-.22],[.49,1.22,.22],.016,iron,g);
    mesh(new T.TorusGeometry(.082,.011,8,32),steel,[.08,.38,.045],g);
    rod([.08,.38,.06],[.08,.24,.10],.014,steel,g);box(.12,.03,.08,.08,.24,.14,iron,g,.008);
    const basket=group('bicycle-basket',.71,.96,0,g);box(.35,.025,.30,0,0,0,steel,basket,.006);
    for(let i=0;i<6;i++){rod([-.17+i*.068,0,-.15],[-.21+i*.084,.25,-.19],.007,steel,basket);rod([-.17+i*.068,0,.15],[-.21+i*.084,.25,.19],.007,steel,basket);}
    for(const y of [.11,.25]){rod([-.21,y,-.19],[.21,y,-.19],.008,steel,basket);rod([-.21,y,.19],[.21,y,.19],.008,steel,basket);rod([-.21,y,-.19],[-.21,y,.19],.008,steel,basket);rod([.21,y,-.19],[.21,y,.19],.008,steel,basket);}
    rod([-.17,.5,0],[-.38,.02,.23],.013,steel,g);
  }
  bicycle(-4.3,2.1,.09);bicycle(2.45,-3.25,Math.PI/2);
  const board=group('neighborhood-noticeboard',-6.02,.28,-2.65);board.rotation.y=Math.PI/2;
  for(const x of [-.48,.48])rod([x,0,0],[x,2.1,0],.045,steel,board);
  box(1.18,1.12,.10,0,1.48,0,wood(),board,.025);box(1.05,.98,.015,0,1.48,.06,toon('#d0c5a6'),board,.008);
  for(let i=0;i<4;i++)poster(i,.39,.41,-.25+(i%2)*.5,1.25+Math.floor(i/2)*.47,.08,board);
  label('町内のお知らせ',1.03,.16,0,2.15,.06,{parent:board,font:80,bg:'#386369',fg:'#eee4c3'});
  // Outdoor compressor fans, meter boxes, conduits, crates and foliage along the alley.
  for(let n=0;n<2;n++){
    const g=group('air-conditioner',2.18,.31,-2.25-n*1.0);g.rotation.y=Math.PI/2;
    box(.86,.62,.37,0,.36,0,cream,g,.045);const fan=cylinder(.22,.22,.025,-.14,.37,.20,iron,g,40);fan.rotation.x=Math.PI/2;
    for(let k=0;k<10;k++)box(.012,.39,.024,-.32+k*.04,.37,.23,steel,g,.003);
    for(let k=0;k<8;k++)box(.24,.013,.02,.27,.15+k*.06,.202,steel,g,0);
    for(const x of [-.30,.30])box(.1,.07,.48,x,.035,0,iron,g,.01);
    tube([[.40,.43,-.05],[.60,.44,-.05],[.60,.89,-.20],[.60,1.25,-.20]],.025,cream,g);
  }
  for(let n=0;n<3;n++){
    const g=group('delivery-crate',.95,.31+n*.28,-5.39);box(.73,.07,.52,0,.03,0,mint,g,.008);
    for(const z of [-.24,.24])for(let k=0;k<3;k++)box(.75,.05,.035,0,.08+k*.075,z,mint,g,.005);
    for(const x of [-.35,.35])for(let k=0;k<3;k++)box(.035,.05,.51,x,.08+k*.075,0,mint,g,.005);
  }
  function plant(x,z,s){const g=group('potted-rain-garden',x,.29,z);g.scale.setScalar(s);cylinder(.22,.16,.37,0,.18,0,toon('#946357'),g,24);cylinder(.20,.20,.035,0,.38,0,toon('#394337'),g,24);
    for(let i=0;i<9;i++){const a=i*2.4,r=.17+.025*(i%3),h=.50+(i%4)*.12;rod([0,.36,0],[Math.cos(a)*r,h,Math.sin(a)*r],.009,toon('#57847c'),g);const leaf=mesh(new T.SphereGeometry(1,14,8),toon(i%2?'#729d90':'#4d817b'),[Math.cos(a)*r,h,Math.sin(a)*r],g);leaf.scale.set(.10,.045,.24);leaf.rotation.set(.55,a,.3);}}
  plant(-5.9,2.18,1.2);plant(2.45,2.38,.9);plant(-5.95,-4.8,.8);plant(-.15,-5.45,1.0);
  // An ornate, small street lamp forms the warm foreground counterpoint.
  const lamp=group('street-lamp',5.9,.07,3.20);cylinder(.16,.25,.29,0,.145,0,iron,lamp,24);cylinder(.065,.09,4.15,0,2.27,0,iron,lamp,24);
  tube([[0,4.18,0],[0,4.55,0],[-.25,4.78,0],[-.65,4.75,0],[-.85,4.52,0]],.055,iron,lamp);
  cylinder(.25,.38,.19,-.85,4.47,0,iron,lamp,32);cylinder(.29,.22,.10,-.85,4.34,0,glow('#ffcf84',2.3),lamp,32);
  const lampLight=new T.PointLight('#ffd38d',12,9,1.8);lampLight.position.set(5.05,4.1,3.2);root.add(lampLight);
  // Two poles and sagging wires stay within the square footprint.
  for(const [x,z,h,span]of[[-5.9,-5.7,6.8,1.25],[6.4,-2.75,6.2,.84]]){
    const g=group('utility-pole',x,.08,z);cylinder(.09,.15,h,0,h/2,0,toon('#777e87'),g,24);
    box(span,.09,.12,0,h-.50,0,iron,g,.009);
    for(const sx of [-span*.416,0,span*.416]){cylinder(.045,.045,.20,sx,h-.38,0,cream,g,14);for(let k=0;k<3;k++)cylinder(.065,.065,.025,sx,h-.46+k*.065,0,steel,g,16);}
    box(.25,.65,.23,0,2.2,.11,iron,g,.025);
    for(let k=0;k<7;k++)box(.25,.055,.24,0,.3+k*.11,.01,toon(k%2?'#d3aa62':'#334052'),g,.005);
  }
  for(let i=0;i<3;i++)tube([[-6.42+i*.52,6.50,-5.7],[-2.8,5.75,-5.1],[2.3,5.4,-3.9],[6.05+i*.35,5.90,-2.75]],.014,iron,root,48);
  tube([[-5.9,5.1,-5.7],[-4.8,4.45,-5.25],[-4.1,4.03,-4.9]],.021,iron,root,24);
  const sign=group('street-name-sign',6.35,3.82,-2.70);label('灯町三丁目',1.20,.34,-.2,0,.16,{parent:sign,font:110,bg:'#365d78',fg:'#dfebdf'});
  const stop=group('stop-sign',6.48,.07,.30);cylinder(.028,.035,1.9,0,.95,0,steel,stop,16);
  const triangle=new T.Shape();triangle.moveTo(0,-.32);triangle.lineTo(.36,.27);triangle.lineTo(-.36,.27);triangle.closePath();mesh(new T.ShapeGeometry(triangle),red,[0,1.95,.03],stop);
  label('止まれ',.39,.17,0,1.98,.038,{parent:stop,font:130,bg:'#b7594e',fg:'#fff0d1'});
  const traffic=group('traffic-signal',-5.45,.07,6.22);cylinder(.048,.06,3.32,0,1.66,0,iron,traffic,20);
  box(.87,.35,.29,-.25,3.25,0,iron,traffic,.1);
  const signalMats=['#629e93','#ba9751','#c85d5b'].map(x=>glow(x,.55));
  for(let i=0;i<3;i++){const o=cylinder(.105,.105,.035,-.52+i*.27,3.25,.17,signalMats[i],traffic,24);o.rotation.x=Math.PI/2;box(.19,.04,.16,-.52+i*.27,3.39,.17,iron,traffic,.01);}
  neighborhood(c);
  return {signalMats,lampLight,vendingLight};
}
