"""Original residents: sculpted surfaces, cloth shape keys and a small rig.
Run inside the dedicated Blender session with WORLD_ROLE and WORLD_OUTPUT set.
References are not embedded. Blender Z-up/-Y-forward -> glTF Y-up/+Z-forward.
"""
import bpy, math, json
from pathlib import Path
from mathutils import Vector, Matrix
ROLE=globals().get('WORLD_ROLE','claude')
OUTPUT=Path(globals()['WORLD_OUTPUT']).resolve();OUTPUT.mkdir(parents=True,exist_ok=True)
PREFIX='WorldArt_'+ROLE;TAU=math.tau
def enum_id(prop,value):return next(i.identifier for i in prop.enum_items if i.identifier.casefold()==value.casefold())
def object_mode():
    if bpy.context.object and bpy.context.object.mode!='OBJECT':bpy.ops.object.mode_set(mode=enum_id(bpy.ops.object.mode_set.get_rna_type().properties['mode'],'OBJECT'))
def linear(v):return v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4
def rgb(s):return tuple(linear(int(s[i:i+2],16)/255) for i in (0,2,4))+(1.,)
def clamp(t,a=0.,b=1.):return max(a,min(b,t))
def smooth(t):
    t=clamp(t);return t*t*(3-2*t)
def mix(a,b,t):return a*(1-t)+b*t
PALETTES={
 'claude':dict(hair='AD512E',light='CE7542',shadow='7F3929',eye='A87836',cloth='F0E5D3',accent='B46637',dark='34302F',metal='BC9758'),
 'codex':dict(hair='D6D2E8',light='F1EDF7',shadow='AEA5CC',eye='9172B5',cloth='F0EDF5',accent='C1B3DB',dark='70648B',metal='C0B4D0'),
 'deepseek':dict(hair='324D83',light='547DB4',shadow='253553',eye='4A91BB',cloth='F0EBDF',accent='455B83',dark='243752',metal='B6A078'),
 'resident':dict(hair='624C3F',light='8E6E50',shadow='45362E',eye='618A6D',cloth='EBE7DA',accent='789585',dark='374D47',metal='B6A078'),
 'player':dict(hair='383A40',light='545966',shadow='25272C',eye='647C85',cloth='D7DBD8',accent='5E7C83',dark='38434D',metal='899A9B')}
if ROLE not in PALETTES:raise ValueError('Explicit authored role required')
p=PALETTES[ROLE]
scene=bpy.data.scenes.get('World_Character_Studio') or bpy.data.scenes.new('World_Character_Studio')
bpy.context.window.scene=scene;object_mode()
old=bpy.data.collections.get(PREFIX)
if old:
    for ob in list(old.all_objects):bpy.data.objects.remove(ob,do_unlink=True)
    bpy.data.collections.remove(old)
collection=bpy.data.collections.new(PREFIX);scene.collection.children.link(collection)
root=bpy.data.objects.new(PREFIX+'_Root',None);collection.objects.link(root)
root['authorship']='Original geometry; user references inform silhouette and palette; reference files not embedded.'
root['role']=ROLE
def material(name,color,rough=.6,metal=0.,coat=0.,sheen=0.,colored=False):
    key=PREFIX+'_'+name;mat=bpy.data.materials.get(key) or bpy.data.materials.new(key);mat.use_nodes=True
    node=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    for key,value in [('Base Color',rgb(color)),('Roughness',rough),('Metallic',metal),('Coat Weight',coat),('Coat Roughness',.3),('Sheen Weight',sheen)]:node.inputs[key].default_value=value
    mat.diffuse_color=rgb(color)
    if name.startswith('Hair'):
        node.inputs['Roughness'].default_value=.57
        node.inputs['Specular IOR Level'].default_value=.24
        node.inputs['Coat Weight'].default_value=0
    if colored:
        vertex=next((n for n in mat.node_tree.nodes if n.type=='VERTEX_COLOR'),None) or mat.node_tree.nodes.new('ShaderNodeVertexColor')
        vertex.layer_name='Color';mat.node_tree.links.new(vertex.outputs['Color'],node.inputs['Base Color'])
    return mat
defs=[('skin','Skin_Painted','FFFFFF',.65,0,.025,0,True),('hair','Hair',p['hair'],.38,0,.14,.1,False),('light','Hair_Satin',p['light'],.42,0,.1,.1,False),('shadow','Hair_Underlayer',p['shadow'],.43,0,.1,0,False),('cloth','Ivory_Linen',p['cloth'],.81,0,0,.3,False),('accent','Accent_Silk',p['accent'],.64,0,.04,.3,False),('dark','Velvet_Ribbon',p['dark'],.76,0,0,.4,False),('metal','Antique_Trim',p['metal'],.38,.68,.05,0,False),('eye','Iris_Painted','FFFFFF',.22,0,.35,0,True),('white','Eye_Porcelain','FFF9ED',.27,0,.25,0,False),('ink','Lashes','322A35',.6,0,0,0,False),('lip','Lip_Line','9F6764',.65,0,0,0,False),('shoe','Soft_Leather',p['dark'],.46,0,.16,0,False)]
materials=[];mat_idx={}
for key,*args in defs:mat_idx[key]=len(materials);materials.append(material(*args))
# One editable mesh, thirteen materials; no separate draw call per ornament.
V=[];F=[];M=[];C=[];W=[];SEATED=[];STRIDE=[];BLINK=[];sections={};skin_color=rgb('F2CDBA')
def cloth_seated(pt):
    x,y,z=pt;t=clamp((.895-z)/.72)
    if t<.20:
        q=t/.20;cy=-.025*smooth(q);cz=mix(.895,.81,q);angle=-math.pi*.43*smooth(q)
    elif t<.65:
        q=(t-.20)/.45;cy=mix(-.025,-.355,q);cz=mix(.81,.755,q);angle=-math.pi*.43
    else:
        q=(t-.65)/.35;cy=-.355-.035*math.sin(q*math.pi*.5);cz=.755-.285*q;angle=-math.pi*.43*(1-smooth(q))
    yn=y/mix(.085,.21,t**1.15);thickness=mix(.085,.087,t)
    return x*.95,cy+yn*thickness*math.cos(angle),cz+yn*thickness*math.sin(angle)
def add(name,verts,faces,mat,bone='Head',weights=None,colors=None,cloth=False,blink=None):
    first=len(V);sections[name]=list(range(first,first+len(verts)))
    for i,raw in enumerate(verts):
        pt=tuple(raw)
        if name.startswith(('Dress_bow_','Dress_flower_')):
            x,y,z=pt;t=clamp((.89-z)/.69);rx=.135+.187*t**1.15;ry=.08825+.122*t**1.12
            pt=(x,-ry*math.sqrt(max(.02,1-(x/rx)**2))+(y+.105)-.002,z)
        V.append(pt);C.append(tuple(colors[i]) if colors else ((1.,1.,1.,1.) if mat!='skin' else skin_color));W.append(weights[i] if weights else {bone:1.})
        SEATED.append(cloth_seated(pt) if cloth else pt)
        t=clamp((.895-pt[2])/.72)
        STRIDE.append((pt[0]+.007*math.sin(pt[0]*12)*t,pt[1]+.035*math.sin(pt[0]*8)*t*t,pt[2]+.006*math.sin(pt[0]*13)*t) if cloth else pt)
        BLINK.append(blink(pt) if blink else pt)
    for face in faces:F.append(tuple(first+i for i in face));M.append(mat_idx[mat])
def catmull(values,t):
    n=len(values);pos=clamp(t)*(n-1);i=min(n-2,int(pos));u=pos-i
    a,b,c,d=[Vector(values[k]) for k in (max(0,i-1),i,i+1,min(n-1,i+2))]
    return .5*((2*b)+(-a+c)*u+(2*a-5*b+4*c-d)*u*u+(-a+3*b-3*c+d)*u*u*u)
def ring_mesh(name,profile,mat,bone='pelvis',sides=64,rows=40,weights_fn=None):
    verts=[];faces=[];weights=[]
    for i in range(rows+1):
        z,rx,ry=catmull(profile,i/rows)
        for j in range(sides):
            a=TAU*j/sides;pt=(rx*math.sin(a),-ry*math.cos(a),z);verts.append(pt);weights.append(weights_fn(pt) if weights_fn else {bone:1.})
    for i in range(rows):
        for j in range(sides):
            a=i*sides+j;b=i*sides+(j+1)%sides;faces.append((a,b,b+sides,a+sides))
    faces.extend([tuple(range(sides-1,-1,-1)),tuple(rows*sides+j for j in range(sides))]);add(name,verts,faces,mat,weights=weights)
def ellipsoid(name,center,radii,mat,bone='Head',sides=28,rows=16,transform=None,cloth=False):
    verts=[];faces=[]
    for i in range(rows+1):
        ph=math.pi*i/rows
        for j in range(sides):
            th=TAU*j/sides;v=Vector((radii[0]*math.sin(ph)*math.cos(th),radii[1]*math.sin(ph)*math.sin(th),radii[2]*math.cos(ph)))
            if transform is not None:v=transform@v
            verts.append(v+Vector(center))
    for i in range(rows):
        for j in range(sides):
            a=i*sides+j;b=i*sides+(j+1)%sides;faces.append((a,a+sides,b+sides,b))
    add(name,verts,faces,mat,bone,cloth=cloth)
def tube(name,points,radii,mat,bone='Head',sides=10,steps=40,wide=1.,deep=1.,weights_fn=None,cloth=False,blink=None):
    verts=[];faces=[];weights=[]
    for i in range(steps+1):
        t=i/steps;c=catmull(points,t);tangent=(catmull(points,min(1,t+.002))-catmull(points,max(0,t-.002))).normalized()
        normal=tangent.cross(Vector((0,1,0)))
        if normal.length<.01:normal=tangent.cross(Vector((1,0,0)))
        normal.normalize();other=tangent.cross(normal).normalized();rp=(len(radii)-1)*t;ri=min(len(radii)-2,int(rp));r=mix(radii[ri],radii[ri+1],rp-ri)
        for j in range(sides):
            a=TAU*j/sides;pt=c+r*(normal*math.cos(a)*wide+other*math.sin(a)*deep);verts.append(pt);weights.append(weights_fn(pt) if weights_fn else {bone:1.})
    for i in range(steps):
        for j in range(sides):
            a=i*sides+j;b=i*sides+(j+1)%sides;faces.append((a,b,b+sides,a+sides))
    faces.extend([tuple(range(sides-1,-1,-1)),tuple(steps*sides+j for j in range(sides))]);add(name,verts,faces,mat,weights=weights,cloth=cloth,blink=blink)
def ribbon(name,points,widths,mat,bone='Head',steps=52,across=14,depth=.007,cloth=False,roll=0.):
    """Lenticular lock / ribbon with varying section and taper, not capsules."""
    verts=[];faces=[]
    for i in range(steps+1):
        t=i/steps;c=catmull(points,t);tangent=(catmull(points,min(1,t+.002))-catmull(points,max(0,t-.002))).normalized();normal=tangent.cross(Vector((0,1,0))).normalized()
        if normal.length<.1:normal=Vector((1,0,0))
        other=tangent.cross(normal).normalized()
        if roll:normal,other=normal*math.cos(roll)+other*math.sin(roll),other*math.cos(roll)-normal*math.sin(roll)
        w=max(.00015,catmull([(w,0,0) for w in widths],t).x)
        for j in range(across):
            a=TAU*j/across;bulge=math.sin(a)*(1+.1*math.cos(3*a));verts.append(c+normal*w*math.cos(a)+other*depth*bulge*math.sqrt(clamp(w/.025,.03,1.4)))
    for i in range(steps):
        for j in range(across):
            a=i*across+j;b=i*across+(j+1)%across;faces.append((a,b,b+across,a+across))
    faces.extend([tuple(range(across-1,-1,-1)),tuple(steps*across+j for j in range(across))]);add(name,verts,faces,mat,bone,cloth=cloth)
# Rounded jaw/cheeks and continuous nose/lip relief, not a scaled ellipsoid.
profile=[(1.382,.012,.025,.028),(1.391,.043,.048,.042),(1.415,.077,.067,.067),(1.444,.102,.082,.084),(1.477,.121,.096,.098),(1.511,.131,.104,.111),(1.548,.133,.104,.119),(1.585,.132,.099,.122),(1.620,.125,.091,.117),(1.654,.104,.074,.100),(1.681,.067,.045,.066),(1.696,.001,.001,.001)]
def face_at_z(z):
    for i in range(len(profile)-1):
        a,b=profile[i:i+2]
        if z<=b[0]:
            t=clamp((z-a[0])/(b[0]-a[0]));d=b[0]-a[0];before=profile[max(0,i-1)];after=profile[min(len(profile)-1,i+2)]
            result=[]
            for k in (1,2,3):
                ma=(b[k]-before[k])/(b[0]-before[0]);mb=(after[k]-a[k])/(after[0]-a[0])
                result.append(max(.001,(2*t**3-3*t*t+1)*a[k]+(t**3-2*t*t+t)*d*ma+(-2*t**3+3*t*t)*b[k]+(t**3-t*t)*d*mb))
            return tuple(result)
    return .001,.001,.001
def face_y(x,z):
    rx,front,back=face_at_z(z);base=-front*math.sqrt(max(0,1-(x/max(rx,.001))**2))
    nose=.018*math.exp(-(x/.014)**2-((z-1.512)/.020)**2);bridge=.005*math.exp(-(x/.012)**2-((z-1.538)/.030)**2)
    ala=.0035*math.exp(-((abs(x)-.011)/.008)**2-((z-1.502)/.008)**2);muzzle=.002*math.exp(-(x/.037)**2-((z-1.476)/.020)**2)
    lip=.004*math.exp(-(x/.028)**4-((z-1.471)/.0045)**2);lower=.0035*math.exp(-(x/.024)**4-((z-1.465)/.005)**2)
    socket=.004*math.exp(-((abs(x)-.062)/.043)**4-((z-1.552)/.026)**4);return base-nose-bridge-ala-muzzle-lip-lower+socket
def face_color(x,y,z):
    c=Vector(rgb('F2CDBA')[:3]);rose=Vector(rgb('DFA599')[:3]);lip=Vector(rgb('D19790')[:3])
    blush=.32*math.exp(-((abs(x)-.092)/.026)**2-((z-1.510)/.018)**2)*clamp(-y/.06);mouth=.45*math.exp(-(x/.025)**4-((z-1.469)/.0055)**2)*clamp(-y/.07)
    return tuple(c.lerp(rose,blush).lerp(lip,mouth))+(1.,)
verts=[];faces=[];colors=[]
for i in range(101):
    z=mix(1.382,1.696,i/100);rx,front,back=face_at_z(z)
    for j in range(128):
        a=TAU*j/128;x=rx*math.sin(a);co=math.cos(a);y=face_y(x,z) if co>=0 else -back*co;verts.append((x,y,z));colors.append(face_color(x,y,z))
for i in range(100):
    for j in range(128):
        a=i*128+j;b=i*128+(j+1)%128;faces.append((a,b,b+128,a+128))
add('Face_sculpt',verts,faces,'skin',colors=colors)
ring_mesh('Neck',[(1.265,.047,.039),(1.303,.041,.036),(1.329,.035,.033),(1.353,.036,.034),(1.39,.046,.041)],'skin','neck_01',sides=48,rows=24)
for side,suf in ((1,'l'),(-1,'r')):
    ellipsoid('Ear_'+suf,(side*.127,.004,1.518),(.022,.014,.036),'skin')
    tube('Ear_fold_'+suf,[(side*.135,-.009,1.542),(side*.144,-.011,1.525),(side*.140,-.012,1.500),(side*.132,-.013,1.511)],[.0023,.003,.003,.0014],'lip',sides=8,steps=24)
def eye_bounds(u):
    arch=max(0,1-u*u)**.67;return 1.554+.027*arch+.003*u,1.554-.019*arch+.003*u
def eye_surface(x,z):
    u=(abs(x)-.062)/.046;top,bottom=eye_bounds(u);v=clamp((z-bottom)/max(top-bottom,.0001));return face_y(x,z)-.0012-.0065*max(0,1-u*u)*math.sin(math.pi*v)
for side,suf in ((1,'l'),(-1,'r')):
    center=side*.062
    def blink_pt(pt):
        x,y,z=pt;nz=1.552+(z-1.552)*.025;return x,face_y(x,nz)-.0016,nz
    ev=[];ef=[]
    for i in range(41):
        u=-1+2*i/40;top,bottom=eye_bounds(u);x=side*(.062+.046*u)
        for j in range(13):z=mix(bottom,top,j/12);ev.append((x,eye_surface(x,z),z))
    for i in range(40):
        for j in range(12):
            a=i*13+j;ef.append((a,a+1,a+14,a+13) if side>0 else (a,a+13,a+14,a+1))
    add('Eye_aperture_'+suf,ev,ef,'white',blink=blink_pt)
    iv=[];ic=[];ifs=[];eyec=Vector(rgb(p['eye'])[:3])
    for ir in range(13):
        radius=ir/12
        for j in range(64):
            a=TAU*j/64;x=center+.0235*radius*math.cos(a);z=1.555+.026*radius*math.sin(a);top,bottom=eye_bounds((abs(x)-.062)/.046);z=clamp(z,bottom+.00015,top-.00015);iv.append((x,eye_surface(x,z)-.00055,z))
            if radius<.34:c=Vector(rgb('292534')[:3])
            else:c=(eyec*(.53+.70*(1-math.sin(a))*.5)*(1+.10*math.sin(j*2.31+ir*.3))).lerp(Vector(rgb('3B3444')[:3]),smooth((radius-.79)/.21)*.85)
            ic.append(tuple(c)+(1.,))
    for ir in range(12):
        for j in range(64):a=ir*64+j;b=ir*64+(j+1)%64;ifs.append((a,b,b+64,a+64))
    add('Iris_'+suf,iv,ifs,'eye',colors=ic,blink=blink_pt)
    for dx,dz,r in ((-.007,.010,.0045),(.007,-.008,.0019)):
        x=center+dx;z=1.555+dz;gv=[]
        for j in range(24):a=TAU*j/24;gx=x+r*math.cos(a);gz=z+r*math.sin(a);gv.append((gx,eye_surface(gx,gz)-.0011,gz))
        add('Iris_glint_'+suf+str(dx),gv,[tuple(range(24))],'white',blink=blink_pt)
    for upper in (True,False):
        pts=[];radii=[]
        for i in range(13):
            u=-1+2*i/12;top,bottom=eye_bounds(u);x=side*(.062+.046*u);z=top if upper else bottom;pts.append((x,face_y(x,z)-.0025,z));radii.append((.0011+.001*math.sin(math.pi*i/12)) if upper else .0007)
        tube(('Upper_lid_' if upper else 'Lower_lid_')+suf,pts,radii,'ink' if upper else 'lip',sides=8,steps=40,blink=blink_pt)
    for i in range(2):
        x=side*(.100+i*.006);z=1.567-i*.003;tube('Lash_'+suf+str(i),[(x,face_y(x,z)-.003,z),(x+side*.009,face_y(x,z),z+.0035)],[.0013,.0001],'ink',steps=8,sides=6,blink=blink_pt)
    pts=[]
    for i in range(6):
        x=side*(.026+i*.014);z=1.594+.005*math.sin(math.pi*i/5)-.004*i/5;pts.append((x,face_y(x,z)-.0015,z))
    tube('Brow_'+suf,pts,[.0014,.0022,.0024,.0021,.0014,.0002],'shadow',steps=30,sides=8,deep=.4)
mouth=[]
for i in range(17):
    x=-.022+.044*i/16;z=1.469+.0030*(abs(x)/.022)**1.5;mouth.append((x,face_y(x,z)-.0008,z))
tube('Mouth_crease',mouth,[.00015]+[.00062]*15+[.00015],'lip',steps=32,sides=8,deep=.45)
def torso_weight(pt):
    z=pt[2];bones=[('pelvis',.87),('spine_01',1.005),('spine_02',1.13),('spine_03',1.26)]
    for (a,za),(b,zb) in zip(bones,bones[1:]):
        if z<=zb:t=smooth((z-za)/(zb-za));return {a:1-t,b:t}
    return {'spine_03':1.}
ring_mesh('Bodice',[(.85,.137,.085),(.91,.122,.079),(.99,.111,.072),(1.075,.129,.086),(1.14,.157,.096),(1.21,.172,.078),(1.25,.149,.058),(1.282,.051,.044)],'cloth' if ROLE!='deepseek' else 'accent',sides=80,rows=46,weights_fn=torso_weight)
ring_mesh('Corset',[(.865,.140,.091),(.90,.128,.085),(.945,.119,.080),(.980,.116,.079)],'dark',sides=80,rows=18,weights_fn=torso_weight)
ring_mesh('Collar',[(1.263,.057,.046),(1.278,.054,.044),(1.295,.051,.042),(1.302,.052,.043)],'cloth','neck_01',sides=48,rows=12)
for i in range(4):
    z=1.18-i*.053;ellipsoid('Bodice_button_'+str(i),(0,-(.098 if z>1.1 else .085),z),(.0045,.003,.0045),'metal','spine_02',sides=16,rows=10)
for side,suf in ((1,'l'),(-1,'r')):
    def sleeve_weight(pt,suf=suf):
        t=smooth((abs(pt[0])-.335)/.075);return {'upperarm_'+suf:1-t,'lowerarm_'+suf:t}
    tube('Continuous_sleeve_'+suf,[(side*.152,0,1.254),(side*.208,0,1.254),(side*.275,0,1.254),(side*.347,0,1.254),(side*.39,0,1.254),(side*.46,0,1.254),(side*.535,0,1.254),(side*.551,0,1.254)],[.054,.067,.068,.048,.040,.036,.027,.029],'cloth' if ROLE!='deepseek' else 'dark','upperarm_'+suf,sides=32,steps=72,deep=.89,weights_fn=sleeve_weight)
    for j in range(3):
        x=side*(.524+j*.008);tube('Cuff_rim_'+suf+str(j),[(x,.034*math.sin(TAU*k/24),1.254+.034*math.cos(TAU*k/24)) for k in range(25)],[.002]*25,'cloth','lowerarm_'+suf,sides=6,steps=48)
    for j in range(5):
        x=side*(.411+j*.022);tube('Cuff_lacing_'+suf+str(j),[(x,-.036,1.245),(x+side*.012,-.037,1.263),(x+side*.022,-.034,1.245)],[.001]*3,'dark','lowerarm_'+suf,sides=6,steps=12)
    ellipsoid('Hand_'+suf,(side*.585,-.002,1.252),(.038,.023,.018),'skin','hand_'+suf,sides=32,rows=20)
    for j in range(4):
        length=(.047,.053,.049,.037)[j];y=-.017+j*.011;tube('Finger_'+suf+str(j),[(side*.603,y,1.253),(side*(.615+length*.5),y-.001,1.248),(side*(.611+length),y-.003,1.242)],[.0062,.0055,.0028],'skin','hand_'+suf,sides=10,steps=15)
    tube('Thumb_'+suf,[(side*.574,-.016,1.250),(side*.590,-.034,1.246),(side*.611,-.035,1.239)],[.008,.007,.0035],'skin','hand_'+suf,sides=10,steps=20)
    tube('Leg_'+suf,[(side*.086,0,.83),(side*.087,0,.64),(side*.087,0,.445),(side*.088,0,.29),(side*.088,0,.105)],[.058,.051,.038,.036,.025],'cloth','thigh_'+suf,sides=32,steps=42,weights_fn=lambda pt,suf=suf:{'thigh_'+suf:1-smooth((.48-pt[2])/.08),'calf_'+suf:smooth((.48-pt[2])/.08)})
    ellipsoid('Boot_toe_'+suf,(side*.088,-.046,.066),(.053,.102,.045),'cloth','foot_'+suf,sides=40,rows=24)
    tube('Boot_shaft_'+suf,[(side*.088,0,.075),(side*.088,0,.125),(side*.088,0,.185)],[.043,.035,.036],'cloth','foot_'+suf,sides=32,steps=20)
    ellipsoid('Boot_sole_'+suf,(side*.088,-.038,.025),(.054,.103,.012),'shoe','foot_'+suf,sides=32,rows=12)
    ellipsoid('Boot_heel_'+suf,(side*.088,.035,.032),(.032,.027,.023),'shoe','foot_'+suf,sides=24,rows=12)
    for j in range(6):
        z=.093+j*.013;y=-.060+j*.0045;tube('Boot_lace_'+suf+str(j),[(side*.088-.016,y,z),(side*.088+.016,y-.001,z+.009)],[.0013,.0013],'accent','foot_'+suf,sides=6,steps=8)
def skirt(name,start,extent,mat,top=.89,bottom=.20,offset=0.,width_taper=0.,scallop=0.):
    verts=[];faces=[];sides=max(24,int(96*extent/TAU));rows=42
    for i in range(rows+1):
        t=i/rows;z=mix(top,bottom,t);long=clamp((.89-z)/.69);rx=.13+.187*long**1.15+offset;ry=.085+.122*long**1.12+offset*.65
        for j in range(sides+1):
            u=j/sides;a=start+extent*u+width_taper*(u-.5)*(1-t);fold=.006*long*math.sin(a*30)+.002*long*math.sin(a*53);verts.append(((rx+fold)*math.sin(a),-(ry+fold*.75)*math.cos(a),z+scallop*math.sin(u*math.pi)*t*t))
    for i in range(rows):
        for j in range(sides):a=i*(sides+1)+j;faces.append((a,a+1,a+sides+2,a+sides+1))
    add(name,verts,faces,mat,'pelvis',cloth=True)
    for side in (0,sides):
        pts=[verts[i*(sides+1)+side] for i in range(rows+1)];tube(name+'_edge_'+str(side),pts,[.0013]*len(pts),'metal','pelvis',steps=42,sides=6,cloth=True)
    pts=[verts[rows*(sides+1)+j] for j in range(sides+1)];tube(name+'_hem',pts,[.0015]*len(pts),'metal','pelvis',steps=max(16,sides),sides=6,cloth=True)
if ROLE!='player':
    skirt('Underskirt',0,TAU,'cloth' if ROLE!='deepseek' else 'dark',bottom=.178)
    verts=[];faces=[]
    for i in range(9):
        t=i/8
        for j in range(161):
            a=TAU*j/160;r=.317+.011*math.sin(t*math.pi)+.008*math.sin(a*38)*(.3+.7*t);verts.append((r*math.sin(a),-r*.66*math.cos(a),.226-.054*t+.004*t*math.cos(a*38)))
    for i in range(8):
        for j in range(160):a=i*161+j;faces.append((a,a+1,a+162,a+161))
    add('Fine_ruffle',verts,faces,'cloth','pelvis',cloth=True)
    if ROLE=='claude':
        skirt('Dark_left',.61,.62,'dark',bottom=.235,offset=.005,width_taper=-.32);skirt('Dark_right',TAU-1.23,.62,'dark',bottom=.235,offset=.005,width_taper=-.32);skirt('Ochre_panel',-.28,.47,'accent',bottom=.267,offset=.009,width_taper=-.24,scallop=.025);skirt('Ivory_overdress',1.10,TAU-2.20,'cloth',bottom=.38,offset=.015,scallop=-.13)
    elif ROLE=='deepseek':
        skirt('Navy_dress',.72,TAU-1.44,'accent',bottom=.24,offset=.01);skirt('Apron',-.75,1.5,'cloth',top=.87,bottom=.37,offset=.017,width_taper=-.22,scallop=-.045)
    else:
        skirt('Lavender_underpanel',.75,TAU-1.5,'accent',bottom=.24,offset=.006);skirt('Ivory_silk_panels',1.15,TAU-2.30,'cloth',bottom=.28,offset=.015,scallop=-.055)
    for i in range(26):
        a=TAU*i/26;x=.303*math.sin(a);y=-.204*math.cos(a);z=.275;tube('Hem_stitch_'+str(i),[(x,y,z),(x*.973,y*.973,z+.025),(x*.948,y*.948,z+.052)],[.0008,.0008,.0005],'metal','pelvis',steps=12,sides=5,cloth=True)
        for side in (-1,1):tube('Hem_leaf_'+str(i)+str(side),[(x*.973,y*.973,z+.025),(x*.973+side*.006*math.cos(a),y*.973+side*.006*math.sin(a),z+.035),(x*.958,y*.958,z+.04)],[.0005,.0012,.0002],'metal','pelvis',steps=8,sides=5,cloth=True)
def flower(name,center,size,bone='Head',cloth=False,petals=10):
    for j in range(petals):
        a=TAU*j/petals+.025*math.sin(j*3.1);verts=[];faces=[]
        for i in range(17):
            u=i/16;r=size*(.14+.85*u)*(1+.06*math.sin(j*2.4));half=size*.19*max(.015,math.sin(math.pi*u))**.65
            for k in range(9):
                v=-1+2*k/8;xx=r;zz=half*v
                yy=center[1]-size*.13*math.sin(math.pi*u)*(1-v*v)+size*.04*u*u
                verts.append((center[0]+xx*math.cos(a)-zz*math.sin(a),yy,center[2]+xx*math.sin(a)+zz*math.cos(a)))
        for i in range(16):
            for k in range(8):q=i*9+k;faces.append((q,q+1,q+10,q+9))
        add(name+'_petal_'+str(j),verts,faces,'accent',bone,cloth=cloth)
    ellipsoid(name+'_heart',center,(size*.24,size*.12,size*.24),'metal',bone,sides=24,rows=12,cloth=cloth)
    for j in range(8):
        a=TAU*j/8;ellipsoid(name+'_stamen_'+str(j),(center[0]+size*.16*math.cos(a),center[1]-.005,center[2]+size*.16*math.sin(a)),(size*.036,.0018,size*.036),'dark',bone,sides=8,rows=6,cloth=cloth)
def bow(name,center,size,bone='Head',cloth=False):
    for side in (-1,1):
        verts=[];faces=[]
        for i in range(25):
            u=i/24;w=size*(.08+.28*math.sin(math.pi*u*.8))
            for k in range(13):
                v=-1+2*k/12;verts.append((center[0]+side*size*u,center[1]-size*.17*math.sin(math.pi*u)-size*.035*math.cos(v*math.pi),center[2]+size*.1*u+w*v))
        for i in range(24):
            for k in range(12):q=i*13+k;faces.append((q,q+1,q+14,q+13))
        add(name+'_loop_'+str(side),verts,faces,'dark',bone,cloth=cloth)
        ribbon(name+'_tail_'+str(side),[(center[0]+side*size*.08,center[1],center[2]),(center[0]+side*size*.3,center[1]-.004,center[2]-size*.5),(center[0]+side*size*.5,center[1]+.002,center[2]-size*1.3)],[size*.08,size*.22,size*.18],'dark',bone,steps=30,across=10,depth=.001,cloth=cloth)
    ellipsoid(name+'_knot',center,(size*.14,.003,size*.17),'dark',bone,sides=24,rows=14,cloth=cloth)
if ROLE=='claude':
    bow('Neck_ribbon',(0,-.100,1.247),.044,'spine_03');flower('Collar_flower',(0,-.111,1.250),.026,'spine_03')
    for side in (-1,1):
        x=side*.16;y=-.105;z=.516;bow('Dress_bow_'+str(side),(x,y,z),.041,'pelvis',True);flower('Dress_flower_'+str(side),(x,y-.004,z+.016),.029,'pelvis',True)
    for i in range(22):
        a=-1.15+2.3*i/21;x=.126*math.sin(a);y=-.087*math.cos(a)-.003;z=.885+.017*abs(math.sin(a));pts=[(x+.0032*math.cos(TAU*j/12),y+.0018*math.sin(TAU*j/12),z+.0028*math.sin(TAU*j/12)) for j in range(13)];tube('Waist_chain_'+str(i),pts,[.00065]*13,'metal','pelvis',sides=5,steps=12)
elif ROLE in ('codex','resident'):
    for i in range(5):ellipsoid('Pearl_button_'+str(i),(0,-.09,1.19-i*.041),(.004,.003,.004),'metal','spine_02',sides=16,rows=10)
else:
    bow('Neck_ribbon',(0,-.103,1.244),.038,'spine_03');ellipsoid('Blue_brooch',(0,-.118,1.241),(.012,.005,.014),'light','spine_03',sides=24,rows=16)
# Closed crown, asymmetrical swept fringe, broad overlapping back locks.
hv=[];hf=[]
for i in range(33):
    t=i/32
    for j in range(96):
        a=TAU*j/96;front=max(0,math.cos(a));ph=.001+(1.96-1.04*front**3-.001)*t;hv.append((.153*math.sin(ph)*math.sin(a),-.141*math.sin(ph)*math.cos(a)+.012,1.545+.174*math.cos(ph)))
for i in range(32):
    for j in range(96):a=i*96+j;b=i*96+(j+1)%96;hf.append((a,b,b+96,a+96))
hf.append(tuple(32*96+j for j in range(95,-1,-1)))
add('Hair_crown',hv,[tuple(reversed(f)) for f in hf],'hair')
if ROLE!='player':
    for i in range(9):
        a=-1.28+2.56*i/8;x=.131*math.sin(a);y=.118*math.cos(a)+.013;end=.83+.085*math.sin(i*1.9)
        pts=[(x*.45,.07,1.683),(x,y,1.569),(x*1.11,y+.018,1.39),(x*1.27+.018*math.sin(i),y+.022,1.18),(x*1.40+.025*math.sin(i*2),y+.035,.98),(x*1.4-.034*math.sin(i+.5),y+.062,end),(x*1.18-.023*math.sin(i),y+.085,end+.027)]
        ribbon('Back_lock_'+str(i),pts,[.0005,.032,.036,.037,.031,.016,.0004],'light' if i in (2,6) else 'hair',steps=68,across=16,depth=.0055,roll=a)
        groove=[(q[0]+.010,q[1]-.007,q[2]) for q in pts[1:-1]];tube('Hair_groove_'+str(i),groove,[.0002,.0007,.0008,.0005,.0001],'shadow',steps=40,sides=5)
    fringe=[
        ([(-.035,.003,1.712),(-.105,-.070,1.665),(-.130,-.100,1.590),(-.129,-.100,1.520),(-.110,-.103,1.490)],[.0005,.025,.026,.015,.0003]),
        ([(-.034,-.006,1.713),(-.073,-.081,1.667),(-.084,-.117,1.620),(-.070,-.120,1.580)],[.0005,.022,.023,.0002]),
        ([(-.033,-.010,1.714),(-.027,-.102,1.660),(-.016,-.134,1.616),(.004,-.129,1.588)],[.0005,.023,.019,.0002]),
        ([(-.030,.005,1.714),(.025,-.095,1.672),(.059,-.132,1.624),(.075,-.124,1.585)],[.0005,.021,.022,.0002]),
        ([(-.025,.010,1.714),(.075,-.062,1.671),(.118,-.113,1.603),(.128,-.100,1.541),(.113,-.101,1.511)],[.0005,.021,.025,.018,.0002])]
    for i,(pts,widths) in enumerate(fringe):
        ribbon('Swept_fringe_'+str(i),pts,widths,'hair',steps=58,across=18,depth=.0027)
        groove=[(q[0]+.004,q[1]-.003,q[2]) for q in pts]
        tube('Fringe_engraving_'+str(i),groove,[.0001,.00035,.00035]+([.0002] if len(pts)==5 else [])+[.0001],'shadow',steps=52,sides=5)
    for side in (-1,1):
        pts=[(side*.055,.008,1.707),(side*.112,-.061,1.652),(side*.139,-.086,1.558),(side*.141,-.105,1.442),(side*.156,-.155,1.295),(side*.169,-.180,1.152),(side*.154,-.185,1.092)];ribbon('Temple_lock_'+str(side),pts,[.0005,.020,.026,.027,.023,.016,.0003],'hair',steps=76,across=16,depth=.0038)
        pts=[(side*.095,.03,1.67),(side*.145,.01,1.56),(side*.164,.005,1.46),(side*.186,.015,1.31),(side*.209,.023,1.18),(side*.225,.05,1.10),(side*.195,.06,1.12)];ribbon('Side_curl_'+str(side),pts,[.0005,.021,.025,.025,.020,.010,.0003],'light',steps=64,across=14,depth=.0038)
else:
    for i in range(6):
        x=-.102+i*.037;ribbon('Short_fringe_'+str(i),[(x*.5,0,1.705),(x,-.08,1.665),(x+.025,-.12,1.60)],[.015,.031,.001],'hair',steps=35,across=14,depth=.008)
if ROLE=='claude':
    bow('Hair_ribbon',(-.125,-.055,1.626),.052);flower('Hair_flower',(-.137,-.099,1.647),.041)
    for side in (-1,1):
        tube('Earring_'+str(side),[(side*.139,-.013,1.493),(side*.143,-.015,1.475),(side*.143,-.016,1.449)],[.0015]*3,'metal',sides=8,steps=16);ellipsoid('Earring_pearl_'+str(side),(side*.143,-.016,1.448),(.0045,.004,.007),'cloth',sides=20,rows=12)
elif ROLE=='codex':
    for side in (-1,1):
        pts=[(side*.107,.025,1.675),(side*.150,.037,1.737),(side*.151,.029,1.798),(side*.134,.015,1.837),(side*.120,.004,1.850)];tube('Sculpted_horn_'+str(side),pts,[.028,.024,.018,.009,.0005],'cloth',sides=28,steps=54)
        for j in range(9):
            t=.12+j*.081;c=catmull(pts,t);r=mix(.028,.004,t);tube('Horn_growth_'+str(side)+str(j),[(c[0]+r*math.cos(TAU*k/20),c[1]+r*math.sin(TAU*k/20),c[2]+.002*math.sin(TAU*k/20)) for k in range(21)],[.0009]*21,'accent',sides=5,steps=20)
    ribbon('Ahoge',[(0,.02,1.70),(-.015,0,1.77),(.027,-.01,1.785),(.052,-.016,1.755)],[.008,.007,.005,.0004],'hair',steps=32,across=10,depth=.003)
    tube('Dragon_tail',[(0,.075,.85),(.10,.17,.64),(.25,.23,.40),(.36,.19,.27),(.44,.13,.30),(.46,.09,.36)],[.052,.052,.043,.029,.018,.001],'hair','pelvis',sides=24,steps=64)
elif ROLE=='deepseek':
    for i in range(15):
        a=math.pi*(.07+.86*i/14);x=.144*math.cos(a);z=1.554+.166*math.sin(a);ribbon('Lace_headband_'+str(i),[(x,.028,z),(x,.002,z+.025),(x,-.008,z+.013)],[.015,.018,.014],'cloth',steps=12,across=8,depth=.002)
    for side in (-1,1):
        ribbon('Whale_ear_'+str(side),[(side*.127,.025,1.558),(side*.176,.027,1.523),(side*.225,.03,1.534),(side*.236,.028,1.552)],[.024,.028,.014,.0004],'hair',steps=34,across=14,depth=.006);bow('Blue_hair_bow_'+str(side),(side*.151,-.026,1.565),.027)
    tube('Whale_tail',[(0,.085,.85),(.13,.18,.63),(.28,.22,.50),(.35,.21,.57)],[.048,.045,.034,.021],'hair','pelvis',sides=24,steps=44)
    for side in (-1,1):ribbon('Tail_fluke_'+str(side),[(.34,.21,.56),(.36+side*.06,.21,.60),(.36+side*.12,.23,.68)],[.025,.04,.001],'hair','pelvis',steps=28,across=14,depth=.009)
if ROLE=='player':
    for side,suf in ((1,'l'),(-1,'r')):tube('Trousers_'+suf,[(side*.084,0,.86),(side*.086,0,.66),(side*.087,0,.445),(side*.088,0,.25),(side*.088,0,.11)],[.069,.061,.048,.044,.037],'dark','thigh_'+suf,sides=40,steps=48,weights_fn=lambda pt,suf=suf:{'thigh_'+suf:1-smooth((.48-pt[2])/.08),'calf_'+suf:smooth((.48-pt[2])/.08)})
# Fuse the crown and primary fringe at the roots, then relax that surface.
# This is a localized sculpt operation; loose curls and engraved strands stay
# separate so the hair retains layered tips without plate-like root seams.
hair_indices=set(i for name,indices in sections.items() if name=='Hair_crown' or name.startswith('Swept_fringe_') for i in indices)
hair_faces=[f for f in F if all(i in hair_indices for i in f)]
hair_used=sorted({i for f in hair_faces for i in f});hair_map={v:i for i,v in enumerate(hair_used)}
temp_data=bpy.data.meshes.new(PREFIX+'_HairSculptSource');temp_data.from_pydata([V[i] for i in hair_used],[],[tuple(hair_map[i] for i in f) for f in hair_faces]);temp_data.update()
temp=bpy.data.objects.new(PREFIX+'_HairSculptSource',temp_data);collection.objects.link(temp)
remesh=temp.modifiers.new('Fuse hair roots',enum_id(bpy.types.ObjectModifiers.bl_rna.functions['new'].parameters['type'],'REMESH'));remesh.mode=enum_id(bpy.types.RemeshModifier.bl_rna.properties['mode'],'VOXEL');remesh.voxel_size=.0015;remesh.use_smooth_shade=True
relax=temp.modifiers.new('Relax root transitions',enum_id(bpy.types.ObjectModifiers.bl_rna.functions['new'].parameters['type'],'SMOOTH'));relax.factor=1.;relax.iterations=26
sub=temp.modifiers.new('Polish sculpt contour',enum_id(bpy.types.ObjectModifiers.bl_rna.functions['new'].parameters['type'],'SUBSURF'));sub.levels=1;sub.render_levels=1
reduce=temp.modifiers.new('Retain sculpt silhouette',enum_id(bpy.types.ObjectModifiers.bl_rna.functions['new'].parameters['type'],'DECIMATE'));reduce.ratio=.055
polish=temp.modifiers.new('Polish sampled outline',enum_id(bpy.types.ObjectModifiers.bl_rna.functions['new'].parameters['type'],'SMOOTH'));polish.factor=.85;polish.iterations=10
bpy.context.view_layer.update();evaluated=temp.evaluated_get(bpy.context.evaluated_depsgraph_get());fused=evaluated.to_mesh()
new_v=[tuple(v.co) for v in fused.vertices];new_f=[];seen_faces=set();discarded=0
for face in fused.polygons:
    indices=tuple(face.vertices);key=tuple(sorted(indices));origin=Vector(new_v[indices[0]])
    area=sum((Vector(new_v[indices[j]])-origin).cross(Vector(new_v[indices[j+1]])-origin).length*.5 for j in range(1,len(indices)-1))
    # Collapse can create reversed duplicate slivers at a hair tip. Remove those
    # numerical remnants at the retopology boundary, before weights/morphs exist.
    if key in seen_faces or area<1e-12:discarded+=1;continue
    seen_faces.add(key);new_f.append(indices)
evaluated.to_mesh_clear();bpy.data.objects.remove(temp,do_unlink=True);bpy.data.meshes.remove(temp_data)
keep=[i for i,f in enumerate(F) if not all(v in hair_indices for v in f)];F[:]=[F[i] for i in keep];M[:]=[M[i] for i in keep]
add('Hair_sculpted_roots',new_v,new_f,'hair')
# Remove the old sculpt construction vertices before creating the editable mesh.
used=sorted({i for f in F for i in f});mapping={old:new for new,old in enumerate(used)}
for values in (V,C,W,SEATED,STRIDE,BLINK):values[:]=[values[i] for i in used]
F[:]=[tuple(mapping[i] for i in face) for face in F]
sections={name:[mapping[i] for i in indices if i in mapping] for name,indices in sections.items() if any(i in mapping for i in indices)}
arm_data=bpy.data.armatures.new(PREFIX+'_Rig');rig=bpy.data.objects.new(PREFIX+'_Rig',arm_data);collection.objects.link(rig);rig.parent=root
bpy.context.view_layer.objects.active=rig;rig.select_set(True);bpy.ops.object.mode_set(mode=enum_id(bpy.ops.object.mode_set.get_rna_type().properties['mode'],'EDIT'))
specs=[('root',None,(0,0,0),(0,0,.14)),('pelvis','root',(0,0,.81),(0,0,.91)),('spine_01','pelvis',(0,0,.91),(0,0,1.06)),('spine_02','spine_01',(0,0,1.06),(0,0,1.19)),('spine_03','spine_02',(0,0,1.19),(0,0,1.29)),('neck_01','spine_03',(0,0,1.29),(0,0,1.40)),('Head','neck_01',(0,0,1.40),(0,0,1.68))]
for side,suf in ((1,'l'),(-1,'r')):specs += [('upperarm_'+suf,'spine_03',(side*.168,0,1.254),(side*.373,0,1.254)),('lowerarm_'+suf,'upperarm_'+suf,(side*.373,0,1.254),(side*.551,0,1.254)),('hand_'+suf,'lowerarm_'+suf,(side*.551,0,1.254),(side*.626,0,1.254)),('thigh_'+suf,'pelvis',(side*.087,0,.81),(side*.087,0,.445)),('calf_'+suf,'thigh_'+suf,(side*.087,0,.445),(side*.088,0,.105)),('foot_'+suf,'calf_'+suf,(side*.088,0,.105),(side*.088,-.12,.065))]
for name,parent,head,tail in specs:
    bone=arm_data.edit_bones.new(name);bone.head=head;bone.tail=tail
    if parent:bone.parent=arm_data.edit_bones[parent]
object_mode();rig.select_set(False)
# Shorten exposed neck without changing body/seat landmarks. All head-attached
# editing regions and their morph positions move together.
for i,weights in enumerate(W):
    if 'Head' in weights:
        for points in (V,SEATED,STRIDE,BLINK):
            x,y,z=points[i];points[i]=(x,y,z-.035)
        x,y,z=SEATED[i]
        if z<1.17:SEATED[i]=(x,y,z+.115*smooth((1.17-z)/.42))
data=bpy.data.meshes.new(PREFIX+'_Sculpt');data.from_pydata(V,[],F);data.update();ob=bpy.data.objects.new(PREFIX+'_Character',data);collection.objects.link(ob);ob.parent=rig
if data.validate(verbose=False,clean_customdata=False):raise RuntimeError('Resident topology changed during validation; fix the construction before export')
for mat in materials:data.materials.append(mat)
for face,mi in zip(data.polygons,M):face.material_index=mi;face.use_smooth=True
color=data.color_attributes.new(name='Color',type=enum_id(bpy.types.Attribute.bl_rna.properties['data_type'],'FLOAT_COLOR'),domain=enum_id(bpy.types.Attribute.bl_rna.properties['domain'],'POINT'))
for v,c in zip(color.data,C):v.color=c
replace=enum_id(bpy.types.VertexGroup.bl_rna.functions['add'].parameters['type'],'REPLACE');groups={name:ob.vertex_groups.new(name=name) for name,_,_,_ in specs}
for i,weights in enumerate(W):
    for name,w in weights.items():
        if w>1e-6:groups[name].add([i],w,replace)
for name,indices in sections.items():ob.vertex_groups.new(name='edit_'+name).add(indices,1,replace)
ob.shape_key_add(name='Basis')
for name,coords in [('Seated_Cloth',SEATED),('Walking_Cloth',STRIDE),('Blink',BLINK)]:
    key=ob.shape_key_add(name=name);key.value=0
    for vert,co in zip(key.data,coords):vert.co=co
modifier=ob.modifiers.new('Resident deformation',enum_id(bpy.types.ObjectModifiers.bl_rna.functions['new'].parameters['type'],'ARMATURE'));modifier.object=rig
root['mesh_vertices']=len(V);root['mesh_polygons']=len(F);root['material_slots']=len(materials);root['runtime_height']=1.70;root['world_rig']='authored-v1'
scene['world_art_role']=ROLE;scene['world_art_output']=str(OUTPUT)
for side,suf in ((1,'l'),(-1,'r')):
    bone=rig.pose.bones['upperarm_'+suf];bone.rotation_mode=enum_id(bpy.types.PoseBone.bl_rna.properties['rotation_mode'],'QUATERNION');rest=bone.bone.matrix_local.to_quaternion();delta=Vector((side,0,0)).rotation_difference(Vector((side*.14,-.025,-1)).normalized());bone.rotation_quaternion=rest.inverted()@delta@rest
bpy.context.view_layer.update()
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':area.spaces.active.region_3d.view_location=(0,0,1.0);area.spaces.active.region_3d.view_distance=3.0;area.tag_redraw()
stats={'role':ROLE,'mesh_objects':1,'vertices':len(V),'polygons':len(F),'triangles':sum(len(f)-2 for f in F),'bones':len(specs),'materials':len(materials),'morphs':['Seated_Cloth','Walking_Cloth','Blink'],'retopology_slivers_removed':discarded,'blender_version':bpy.app.version_string}
(OUTPUT/(ROLE+'-geometry.json')).write_text(json.dumps(stats,indent=2),encoding='utf8');print('WORLD_CHARACTER_BUILT',json.dumps(stats),flush=True)
