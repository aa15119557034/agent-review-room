import * as T from 'three';
import { buildRoof } from './roof.js';

export function buildStore(c) {
  const {root,box,cylinder,sphere,tube,rod,group,toon,glow,label,poster,mesh}=c;
  const cream=toon('#b8baa9',.025),trim=toon('#327e7b',.035),dark=toon('#202e40'),metal=toon('#768c91'),warm=toon('#ead5ac',.08),wood=toon('#94725b'),white=toon('#e8dfc5',.08);
  const goods=['#d86b5d','#f1bc63','#87b99d','#739aaf','#e5dba9','#a58cae'].map(x=>toon(x,.05));
  const glass=new T.MeshPhysicalMaterial({color:'#a4d6d2',transparent:true,opacity:.10,roughness:.12,metalness:.05,depthWrite:false,side:T.DoubleSide});
  const shop=group('convenience-store');
  box(7.7,.22,6.2,-1.95,.22,-1.8,toon('#7b8b8b'),shop,.06);
  box(7.3,.04,5.8,-1.95,.35,-1.8,warm,shop,0);
  const floorMats=[toon('#cfc5aa',.18),toon('#bcbca6',.18)];floorMats.forEach(mat=>mat.userData.inkWeight=.08);
  for(let x=-5.35;x<1.6;x+=.6)for(let z=-4.55;z<1.15;z+=.6)box(.58,.009,.58,x,.38,z,floorMats[(Math.round(x*5+z*5)%3)?0:1],shop,0);
  box(7.45,3.25,.17,-1.95,1.96,-4.74,cream,shop);
  box(.17,3.25,5.9,-5.65,1.96,-1.85,cream,shop);
  box(7.5,.32,.2,-1.95,.55,1.17,trim,shop);
  box(.2,.32,5.95,1.77,.55,-1.83,trim,shop);
  for(const x of [-5.61,-3.05,-1.7,.12,1.76])box(.105,2.63,.16,x,1.94,1.21,metal,shop,.013);
  for(const z of [-4.74,-3.0,-1.25,1.2])box(.16,2.65,.10,1.77,1.95,z,metal,shop,.013);
  for(const y of [.66,2.97]){box(7.5,.09,.13,-1.95,y,1.23,metal,shop,.008);box(.13,.09,5.95,1.79,y,-1.82,metal,shop,.008);}
  for(const [x,w]of[[-4.34,2.47],[-2.38,1.20],[.95,1.52]])box(w,2.25,.018,x,1.83,1.239,glass,shop,0);
  for(const [z,d]of[[-3.87,1.6],[-2.13,1.6],[-.04,2.31]])box(.018,2.25,d,1.79,1.83,z,glass,shop,0);
  const door=group('automatic-door',-.79,.36,1.24,shop);door.userData.dynamic=true;
  const left=group('door-left',-.43,0,0,door),right=group('door-right',.43,0,0,door);
  for(const leaf of [left,right]){
    box(.83,2.53,.028,0,1.27,0,glass,leaf,0);
    for(const x of [-.42,.42])box(.045,2.55,.065,x,1.27,0,metal,leaf,.006);
    for(const y of [.08,2.52])box(.86,.045,.065,0,y,0,metal,leaf,.006);
    box(.82,.12,.022,0,1.02,.04,toon('#e1d3a0',.12),leaf,0);
    label('自動',.23,.15,0,1.32,.05,{parent:leaf,font:110,bg:'#405c61',fg:'#fff2c8'});
  }
  box(1.95,.14,.20,-.79,3.0,1.26,dark,shop);
  box(.17,.06,.11,-.79,2.94,1.39,glow('#a7e1d5',.6),shop,.01);
  // Slim overhang and hanging sign sit below the serviced flat roof.
  box(7.9,.18,6.4,-1.95,3.64,-1.75,dark,shop,.055);
  box(8.12,.15,1.08,-1.95,3.41,1.54,trim,shop,.03);
  box(8.12,.04,.10,-1.95,3.31,2.04,glow('#ffe6b4',1.5),shop,.01);
  box(8.0,.69,.17,-1.95,3.88,1.53,trim,shop,.025);
  label('雨あかり',4.05,.51,-2.55,3.88,1.626,{bg:'#2b6466',fg:'#fff2c2',sub:'AMEAKARI  ·  YOUR NEIGHBORHOOD MART',font:106,lit:true,parent:shop});
  label('24',.68,.47,1.05,3.88,1.63,{bg:'#e7bc75',fg:'#264f59',sub:'OPEN',font:130,lit:true,parent:shop});
  box(.15,.69,6.14,2.02,3.88,-1.7,trim,shop,.025);
  const side=label('雨あかり',3.9,.50,2.107,3.87,-1.7,{bg:'#2b6466',fg:'#fff2c2',sub:'OPEN 24 HOURS',font:105,lit:true,parent:shop});side.rotation.y=Math.PI/2;
  buildRoof(c,shop);
  tube([[1.9,3.6,-4.8],[2.06,3.45,-4.8],[2.06,.5,-4.8],[2.2,.22,-4.8]],.055,metal,shop);
  // The reverse side remains a finished service alley when the miniature is rotated.
  const service=group('rear-service-entrance',-.15,.38,-4.84,shop);service.rotation.y=Math.PI;
  box(1.03,2.25,.075,0,1.13,0,dark,service,.025);box(.91,2.12,.045,0,1.11,.06,toon('#687f85'),service,.02);
  box(.34,.56,.016,0,1.52,.09,toon('#96b9b9',.08),service,.015);box(.045,.30,.05,-.31,1.0,.11,metal,service,.01);
  for(let i=0;i<7;i++)box(.58,.025,.012,0,.34+i*.057,.089,dark,service,.003);
  label('搬入口',.65,.20,0,2.45,.08,{parent:service,font:120,bg:'#4e6264',fg:'#dfd7b7'});
  box(.50,.13,.28,0,2.83,.09,dark,service,.035);box(.41,.07,.20,0,2.75,.14,glow('#ffddad',1.7),service,.020);
  for(const x of [-4.65,-2.98]){
    box(1.19,.61,.035,x,2.62,-4.849,dark,shop,.02);box(1.08,.50,.018,x,2.62,-4.88,toon('#8aa6aa',.04),shop,.012);
    for(const sx of [-.35,0,.35])box(.025,.54,.018,x+sx,2.62,-4.90,metal,shop,.004);
  }
  box(7.44,.34,.05,-1.95,.57,-4.85,metal,shop,.01);
  tube([[-5.76,3.51,-4.83],[-5.81,3.3,-4.86],[-5.81,.54,-4.86],[-5.92,.27,-4.86]],.044,metal,shop);
  const meters=group('electrical-meter-cabinets',-5.76,.38,-2.32,shop);meters.rotation.y=-Math.PI/2;
  for(let i=0;i<3;i++){
    box(.42,.63,.20,-.52+i*.52,1.51,0,toon('#73838b'),meters,.028);
    box(.18,.18,.015,-.52+i*.52,1.64,.108,toon('#c1c4a7'),meters,.012);
    cylinder(.055,.055,.015,-.52+i*.52,1.65,.124,dark,meters,24).rotation.x=Math.PI/2;
    tube([[-.52+i*.52,1.18,0],[-.52+i*.52,.64,0],[.85,.64,0],[.85,.10,0]],.016,metal,meters);
    label('電源',.21,.09,-.52+i*.52,1.33,.108,{parent:meters,font:140,bg:'#52646b',fg:'#d3d1b7'});
  }
  rod([-5.76,2.89,-3.5],[-5.76,2.89,-.7],.025,metal,shop);

  function product(x,y,z,type=0,parent=shop){
    const color=goods[type%goods.length];
    const kind=type%4,g=group(['product-bottle','product-snack-bag','product-cup-noodles','product-carton'][kind],x,y,z,parent);
    if(kind===0){
      cylinder(.050,.057,.18,0,.09,0,color,g,20);cylinder(.025,.050,.045,0,.202,0,color,g,20);
      cylinder(.025,.025,.027,0,.236,0,white,g,16);cylinder(.032,.032,.023,0,.256,0,color,g,16);
      box(.080,.075,.007,0,.11,.054,white,g,.006);box(.045,.015,.003,0,.12,.059,color,g,.002);
    }else if(kind===1){
      const bag=mesh(new T.SphereGeometry(1,20,12),color,[0,.135,0],g);bag.scale.set(.077,.118,.043);
      for(const sy of [.018,.25]){box(.15,.018,.028,0,sy,0,color,g,.004);for(let i=0;i<5;i++)box(.008,.012,.004,-.055+i*.028,sy,.016,white,g,.001);}
      box(.092,.076,.012,0,.143,.040,white,g,.014);const emblem=sphere(.024,0,.145,.052,color,g);emblem.scale.z=.20;
      g.rotation.z=(type%3-1)*.055;
    }else if(kind===2){
      cylinder(.079,.055,.125,0,.065,0,color,g,24);cylinder(.083,.083,.014,0,.135,0,white,g,24);
      cylinder(.065,.065,.004,0,.145,0,color,g,24);box(.085,.044,.009,0,.075,.068,white,g,.008);
      box(.034,.008,.025,.063,.146,.03,white,g,.004);
    }else{
      box(.13,.19,.087,0,.095,0,color,g,.008);
      const top=mesh(new T.CylinderGeometry(.072,.072,.087,3,1),white,[0,.205,0],g);top.rotation.x=-Math.PI/2;
      box(.068,.072,.006,0,.095,.047,white,g,.004);box(.09,.015,.012,0,.275,0,color,g,.002);
    }
  }
  const riceShape=new T.Shape();riceShape.moveTo(-.072,0);riceShape.quadraticCurveTo(-.09,.01,-.063,.05);riceShape.lineTo(-.012,.155);riceShape.quadraticCurveTo(0,.18,.014,.151);riceShape.lineTo(.074,.025);riceShape.quadraticCurveTo(.086,0,.06,0);riceShape.closePath();
  const riceGeometry=new T.ExtrudeGeometry(riceShape,{depth:.062,bevelEnabled:true,bevelSegments:2,steps:1,bevelSize:.009,bevelThickness:.009});
  const lid=new T.MeshPhysicalMaterial({color:'#e5eeef',transparent:true,opacity:.22,roughness:.12,depthWrite:false});
  function meal(x,y,z,kind,parent){
    if(kind%2===0){mesh(riceGeometry,white,[x,y+.018,z-.035],parent);box(.060,.080,.008,x,y+.055,z+.038,toon('#304b40'),parent,.005);}
    else{box(.17,.028,.16,x,y+.015,z,dark,parent,.014);box(.14,.023,.13,x,y+.04,z,white,parent,.01);box(.052,.026,.10,x+.035,y+.063,z,goods[0],parent,.012);sphere(.021,x-.04,y+.063,z+.03,goods[2],parent);box(.18,.055,.17,x,y+.075,z,lid,parent,.012);for(const sx of [-.082,.082])box(.008,.009,.155,x+sx,y+.10,z,white,parent,.002);}
  }
  const shelfMetal=toon('#b5c4ce',.12),shelfBack=toon('#8e9ea9',.06),shelfEdge=toon('#697f91',.07);
  function shelf(x,z,index){
    const g=group('stocked-grocery-shelf',x,.39,z,shop);
    box(2.63,.12,.68,0,.07,0,shelfEdge,g);
    for(const sx of [-1.26,1.26])box(.06,1.45,.64,sx,.74,0,shelfMetal,g,.008);
    box(2.58,1.35,.055,0,.77,-.28,shelfBack,g,.008);
    for(let level=0;level<4;level++){
      const y=.17+level*.36;box(2.6,.045,.68,0,y,0,shelfMetal,g,.008);
      box(2.61,.055,.025,0,y-.006,.355,shelfEdge,g,.004);
      for(let j=0;j<13;j++){
        box(.115,.027,.008,-1.17+j*.19,y-.005,.373,white,g,.002);
        if(index===0&&level<3){meal(-1.17+j*.19,y+.025,.12,j+level,g);meal(-1.17+j*.19,y+.025,-.10,j+level,g);}
        else{product(-1.17+j*.19,y+.025,.12,j+level+index,g);if(level<3)product(-1.17+j*.19,y+.025,-.10,j+level+index,g);}
      }
    }
    label(index?'お菓子 · SNACKS':'お弁当 · FRESH DAILY',2.25,.20,0,1.64,.04,{parent:g,font:70,bg:'#ced8d6',fg:'#39586a'});
  }
  shelf(-3.65,-2.75,0);shelf(-3.65,-.95,1);
  // Back wall chilled display: each visible glass door contains actual drink geometry.
  const drinks=group('refrigerated-drinks',-1.2,.38,-4.34,shop);
  box(5.25,2.46,.06,0,1.24,-.29,dark,drinks,.02);
  for(const x of [-2.62,2.62])box(.06,2.46,.64,x,1.24,0,dark,drinks,.01);
  for(const y of [.04,2.46])box(5.25,.07,.64,0,y,0,dark,drinks,.01);
  for(let unit=0;unit<5;unit++){
    const x=-2.10+unit*1.05;
    box(.98,2.13,.035,x,1.25,-.22,white,drinks,.008);
    for(const side of [-.48,.48])box(.028,2.13,.55,x+side,1.25,.05,metal,drinks,.005);
    box(.81,2.00,.018,x,1.26,.345,glass,drinks,0);
    box(.025,1.89,.03,x-.41,1.25,.37,glow('#c4e9e3',1.2),drinks,.003);
    for(let level=0;level<5;level++){const y=.36+level*.36;box(.92,.03,.53,x,y,.07,metal,drinks,.005);for(let j=0;j<5;j++)product(x-.34+j*.17,y+.022,.19,((unit+level)%2?0:3)+unit*4,drinks);}
    box(.035,.38,.055,x+.35,1.2,.41,metal,drinks,.01);
  }
  label('冷たい飲みもの  ·  DRINKS',4.85,.22,0,2.56,.36,{parent:drinks,lit:true,font:75,bg:'#d1e8d9',fg:'#235b5c'});
  // Cashier, point of sale, coffee maker and oden tray.
  const counter=group('cashier-coffee-and-oden',.45,.38,-.55,shop);
  box(1.55,1.05,1.15,0,.53,0,trim,counter,.035);box(1.72,.08,1.24,0,1.10,0,warm,counter,.025);
  box(.40,.08,.34,-.43,1.18,.20,dark,counter);rod([-.43,1.22,.14],[-.43,1.51,.09],.045,metal,counter);
  const screen=box(.39,.26,.055,-.43,1.54,.09,dark,counter,.015);screen.rotation.x=-.22;
  label('レジ',.30,.13,-.43,1.55,.125,{parent:counter,font:130,bg:'#172d36',fg:'#9accb9',lit:true});
  box(.40,.66,.40,.39,1.46,-.31,dark,counter,.035);box(.35,.09,.31,.39,1.18,-.26,metal,counter,.012);
  cylinder(.10,.08,.14,.39,1.30,-.14,white,counter,24);box(.13,.09,.02,.39,1.63,-.10,glow('#b9ddc6',.7),counter,.005);
  const tray=group('oden-display',.20,1.16,.28,counter);
  box(.65,.09,.42,0,.02,0,metal,tray,.012);box(.58,.02,.35,0,.07,0,toon('#b68c51',.25),tray,.005);
  for(let i=0;i<6;i++)sphere(.063,-.22+(i%3)*.21,.125,-.08+Math.floor(i/3)*.16,toon(i%2?'#ead69a':'#b4784c',.1),tray);
  for(const x of [-.34,.34])box(.015,.35,.44,x,.19,0,glass,tray,0);
  box(.68,.35,.015,0,.19,.22,glass,tray,0);box(.7,.02,.47,0,.38,0,metal,tray,.005);
  label('おでん',.43,.13,0,.12,.235,{parent:tray,font:110,bg:'#c97551',fg:'#fff1c9'});
  // Open-topped ice cream freezer, magazines, staff door, interior signs.
  const freezer=group('ice-cream-freezer',-4.85,.39,.22,shop);
  box(1.1,.82,.72,0,.43,0,white,freezer,.045);box(.95,.06,.59,0,.87,0,glass,freezer,.005);
  for(let i=0;i<10;i++)box(.12,.035,.20,-.4+(i%5)*.2,.80,-.15+Math.floor(i/5)*.3,goods[i%6],freezer,.006);
  label('ICE CREAM',.86,.22,0,.52,.37,{parent:freezer,font:80,bg:'#aed5d5',fg:'#305866'});
  const mag=group('magazine-rack',-2.55,.38,.66,shop);box(.53,.65,.32,0,.32,0,metal,mag,.01);
  for(let i=0;i<6;i++){const p=poster(i,.19,.28,-.12+(i%2)*.24,.32+Math.floor(i/2)*.20,.18+Math.floor(i/2)*.02,mag);p.rotation.x=-.12;}
  const rear=group('staff-door',.82,.39,-4.25,shop);box(.85,2.12,.06,0,1.06,.36,wood,rear,.02);label('STAFF ONLY',.55,.15,0,1.50,.40,{parent:rear,font:70});sphere(.035,.27,.99,.42,metal,rear);
  const fluorescent=glow('#eff4ee',1.35);
  for(const x of [-3.95,-.35])for(const z of [-2.8,-1.25,.30]){
    const fixture=group('white-fluorescent-pair',x,2.75,z,shop);
    box(1.72,.065,.25,0,0,0,shelfMetal,fixture,.012);
    for(const sx of [-.66,.66])rod([sx,.03,0],[sx,.75,0],.008,metal,fixture);
    for(const tz of [-.065,.065]){const lamp=cylinder(.025,.025,1.54,0,-.055,tz,fluorescent,fixture,16);lamp.rotation.z=Math.PI/2;for(const sx of [-.80,.80])box(.06,.07,.065,sx,-.052,tz,white,fixture,.007);}
  }
  label('できたて、ごはん。',2.6,.25,-3.4,2.78,-3.9,{parent:shop,font:75,bg:'#e6b979',fg:'#534d49'});
  poster(0,.52,.8,-4.83,2.12,1.26,shop);poster(1,.52,.8,.88,2.12,1.26,shop);
  box(1.4,.025,.72,-.79,.41,1.69,toon('#4d7472'),root,.01);
  const matLabel=label('いらっしゃいませ',1.1,.20,-.79,.427,1.7,{parent:root,font:70,bg:'#4d7472',fg:'#d6d4b3'});matLabel.rotation.x=-Math.PI/2;
  const guide=label('お会計 →',.66,.22,.15,.405,.68,{parent:shop,font:110,bg:'#cfc5aa',fg:'#8e7355'});guide.rotation.x=-Math.PI/2;
  const lights=[];
  for(const [x,z,color]of[[-3.8,-1.5,'#fff0d9'],[.1,-1.5,'#fff0d9'],[-1.5,.8,'#ffdbb1']]){const l=new T.PointLight(color,6.2,8,1.8);l.position.set(x,2.9,z);root.add(l);lights.push(l);}
  const signLight=new T.PointLight('#87d5c4',2.6,6,1.7);signLight.position.set(-2.1,3.1,2.1);root.add(signLight);
  return {doorLeft:left,doorRight:right,door,signLight,lights,glass,front:{x:-1.95,z:1.26,width:7.5,height:2.25,y:1.83}};
}
