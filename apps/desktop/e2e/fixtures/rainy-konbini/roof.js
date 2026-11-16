import * as T from 'three';

export function buildRoof(c,parent){
  const {box,cylinder,rod,tube,mesh,group,toon,label}=c;
  const roof=group('flat-roof-services',-1.95,4.02,-1.84,parent);
  const concrete=toon('#727f99'),cap=toon('#9ba6b5'),iron=toon('#34425a'),steel=toon('#8595a4'),dark=toon('#25344b');
  box(7.80,.16,6.18,0,0,0,toon('#526175'),roof,.045);
  for(const z of [-3.03,3.03]){box(7.84,.31,.15,0,.19,z,concrete,roof,.025);box(7.9,.055,.21,0,.37,z,cap,roof,.018);}
  for(const x of [-3.84,3.84]){box(.15,.31,5.96,x,.19,0,concrete,roof,.025);box(.21,.055,5.99,x,.37,0,cap,roof,.018);}
  for(let i=0;i<5;i++)box(.028,.006,5.8,-2.9+i*1.42,.084,0,toon('#64718a'),roof,0);
  // Two condensers have visible feet, fan blades, protective grilles and fins.
  for(const [x,z,w,h,d]of[[-1.6,-.65,1.65,.80,1.1],[1.05,-1.3,1.35,.70,.94]]){
    const unit=group('roof-condenser',x,.10,z,roof);
    for(const sx of [-w*.34,w*.34]){box(.15,.10,d+.15,sx,.05,0,dark,unit,.014);box(.12,.09,d+.09,sx,.13,0,steel,unit,.008);}
    box(w,h,d,0,.20+h/2,0,toon('#a3b1bc'),unit,.045);
    for(let i=0;i<12;i++)box(w*.78,.022,.026,0,.29+i*(h-.15)/12,d/2+.018,dark,unit,.005);
    for(const sx of [-w*.44,w*.44])box(.034,h*.78,.032,sx,.20+h/2,d/2+.026,steel,unit,.004);
    cylinder(.34,.34,.025,0,h+.22,0,dark,unit,48);
    for(let i=0;i<7;i++){const a=i*Math.PI*2/7;const blade=box(.13,.018,.25,Math.sin(a)*.12,h+.245,Math.cos(a)*.12,steel,unit,.025);blade.rotation.y=a+.45;}
    cylinder(.075,.075,.035,0,h+.26,0,cap,unit,24);
    const ring=mesh(new T.TorusGeometry(.34,.018,8,48),iron,[0,h+.28,0],unit);ring.rotation.x=Math.PI/2;
    for(let i=-3;i<=3;i++){const half=Math.sqrt(.32*.32-(i*.08)**2);rod([-half,h+.29,i*.08],[half,h+.29,i*.08],.007,iron,unit);}
    label('室外機',.34,.12,w*.26,.32,d/2+.034,{parent:unit,font:100,bg:'#627485',fg:'#dbe4e0'});
    tube([[w/2,.48,0],[w/2+.20,.48,0],[w/2+.20,.12,-.35],[w/2+.55,.12,-.35]],.034,cap,unit);
  }
  const tank=group('roof-water-tank',-2.65,.10,-2.0,roof);
  for(const x of [-.34,.34])for(const z of [-.34,.34])box(.08,.28,.08,x,.14,z,iron,tank,.008);
  box(1.04,.08,1.04,0,.28,0,steel,tank,.025);
  cylinder(.48,.48,1.08,0,.86,0,toon('#b3bfc5'),tank,48);
  cylinder(.51,.51,.08,0,1.42,0,cap,tank,48);cylinder(.16,.16,.07,0,1.49,0,iron,tank,24);
  for(const y of [.40,.89,1.36]){const ring=mesh(new T.TorusGeometry(.484,.016,8,48),steel,[0,y,0],tank);ring.rotation.x=Math.PI/2;}
  tube([[.42,.48,0],[.70,.48,0],[.77,.32,0],[.77,.10,1.8],[2.55,.10,1.8]],.044,cap,tank);
  for(const x of [-.28,.28])rod([x,.10,.56],[x,1.38,.56],.017,iron,tank);
  for(let i=0;i<7;i++)rod([-.28,.18+i*.18,.57],[.28,.18+i*.18,.57],.014,iron,tank);
  tube([[-2.5,.14,-.9],[-2.5,.14,1.35],[-1.8,.14,1.65],[2.8,.14,1.65],[3.1,.14,2.45]],.032,steel,roof);
  for(const x of [-2,-.6,.8,2.2])box(.12,.10,.25,x,.10,1.65,iron,roof,.01);
  const hatch=group('roof-access-hatch',1.9,.12,1.0,roof);box(1.1,.11,.85,0,0,0,iron,hatch,.035);box(.98,.05,.72,0,.075,0,toon('#768997'),hatch,.02);rod([-.18,.12,.15],[.18,.12,.15],.022,cap,hatch);
}
