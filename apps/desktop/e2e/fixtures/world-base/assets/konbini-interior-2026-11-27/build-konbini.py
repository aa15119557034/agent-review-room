"""Build the original W1 detail props in lot-local coordinates, then export GLB."""
import json
import sys
from math import atan2, cos, pi, sin
from pathlib import Path
from random import Random

import bpy
from mathutils import Vector


ROOT = Path(__file__).parent
ATLAS = json.loads((ROOT/'atlas-layout.json').read_text(encoding='utf-8'))
FLOOR = .30
CREAM = 'e5d9be'
PORCELAIN = 'f6ecd5'
METAL = '7d939a'
INK = '344752'
TEAL = '438b83'
RIM = '688786'
COLD = 'c6e5e7'
BLUSH = 'c77766'
GOLD = 'ddab5e'


def linear(value):
    result = []
    for i in (0, 2, 4):
        c = int(value[i:i+2], 16)/255
        result.append(c/12.92 if c <= .04045 else ((c+.055)/1.055)**2.4)
    return (*result, 1.0)


def mix(a, b, amount):
    return tuple(x+(y-x)*amount for x,y in zip(a,b))


def tile_uv(label, solid=False):
    col,row = ATLAS['items'][label]['cell']
    grid,tile = ATLAS['grid'],ATLAS['tile']
    size = grid*tile
    if solid:
        uv = ((col*tile+3.5)/size,1-(row*tile+3.5)/size)
        return (uv,)*4
    u0,u1 = (col*tile+4.5)/size,((col+1)*tile-4.5)/size
    v0,v1 = 1-((row+1)*tile-4.5)/size,1-(row*tile+4.5)/size
    return ((u0,v0),(u1,v0),(u1,v1),(u0,v1))


class Batch:
    def __init__(self):
        self.points, self.faces, self.colors, self.uv, self.smooth = [], [], [], [], []

    def vertices(self, points, color):
        first = len(self.points)
        self.points.extend((x,-z,y) for x,y,z in points)
        self.colors.extend([color]*len(points))
        return first

    def face(self, first, indices, uv=None, smooth=False):
        self.faces.append(tuple(first+i for i in indices))
        self.uv.append(uv)
        self.smooth.append(smooth)

    def add_to(self, root, material, suffix):
        if not self.points:
            return
        name = root.name+'-'+suffix
        data = bpy.data.meshes.new(name)
        data.from_pydata(self.points, [], self.faces)
        data.update()
        obj = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(obj)
        obj.parent = root
        data.materials.append(material)
        color = data.color_attributes.new(name='PropColor',type='FLOAT_COLOR',domain='POINT')
        data.color_attributes.active_color = color
        for i,rgba in enumerate(self.colors):
            color.data[i].color = rgba
        coords = data.uv_layers.new(name='UVMap') if any(self.uv) else None
        for poly,uv,smooth in zip(data.polygons,self.uv,self.smooth):
            poly.use_smooth = smooth
            if coords and uv:
                for loop,point in zip(poly.loop_indices,uv):
                    coords.data[loop].uv = point


FACES = {
    'front': (4,5,6,7), 'back': (1,0,3,2),
    'right': (5,1,2,6), 'left': (0,4,7,3),
    'top': (3,7,6,2), 'bottom': (0,1,5,4),
}
AXIS = {'front':(0,1),'back':(0,-1),'right':(1,0),'left':(-1,0)}


class Fixture:
    def __init__(self,name,materials):
        self.root = bpy.data.objects.new(name,None)
        bpy.context.collection.objects.link(self.root)
        self.solid,self.atlas,self.glass,self.glow = (Batch() for _ in range(4))
        self.materials = materials

    def finish(self):
        for batch,name in ((self.solid,'paint'),(self.atlas,'labels'),(self.glass,'glass'),(self.glow,'lights')):
            batch.add_to(self.root,self.materials[name],name)

    def box(self,x,y,z,w,h,d,color=CREAM,*,label=None,face='front',layer='paint',tilt=0,on_shelf=False):
        batch = self.atlas if label else {'paint':self.solid,'glass':self.glass,'lights':self.glow}[layer]
        c = (1.0,1.0,1.0,1.0) if label else linear(color)
        x0,x1=x-w/2,x+w/2
        b,t=z-d/2,z+d/2
        points=[(x0,y,b),(x1,y,b),(x1,y+h,b+tilt),(x0,y+h,b+tilt),
                (x0,y,t),(x1,y,t),(x1,y+h,t+tilt),(x0,y+h,t+tilt)]
        first = batch.vertices(points,c)
        for name,indices in FACES.items():
            if on_shelf and name == 'bottom':
                continue
            batch.face(first,indices,tile_uv(label,solid=name!=face) if label else None)

    def tube(self,x,y,z,rings,color,*,side='front',label=None,sides=8,lid_from=None):
        batch = self.atlas if label else self.solid
        dx,dz=AXIS[side]
        phase=atan2(dz,dx)-pi/sides
        color = (1.0,1.0,1.0,1.0) if label else linear(color)
        first=len(batch.points)
        for height,radius in rings:
            pts=[(x+cos(phase+i*2*pi/sides)*radius,y+height,z+sin(phase+i*2*pi/sides)*radius)
                 for i in range(sides)]
            batch.vertices(pts,color)
        for row in range(len(rings)-1):
            start=row*sides
            for i in range(sides):
                j=(i+1)%sides
                # The primary label faces the aisle, with the rest of the sleeve in the base ink.
                if lid_from is not None and row >= lid_from:
                    uv = tile_uv('price_128', solid=True)
                else:
                    uv=tile_uv(label,solid=(i!=0 or row!=0)) if label else None
                batch.face(first,(start+j,start+i,start+i+sides,start+j+sides),uv,True)
        # Bottom caps are never exposed. The top is a closed horizontal polygon.
        cap=tuple(reversed(range((len(rings)-1)*sides,len(rings)*sides)))
        lid = 'price_128' if lid_from is not None else label
        caps=tile_uv(lid,True)[0:1]*len(cap) if lid else None
        batch.face(first,cap,caps)

    def bag(self,x,y,z,side,w,h,t,label):
        sx,sz=AXIS[side]
        along=(sz, -sx)
        profile=[(-.43,0),(.43,0),(.50,.15),(.43,1),(-.43,1),(-.50,.15)]
        points=[(x+along[0]*u*w+sx*q*t,y+v*h,z+along[1]*u*w+sz*q*t)
                for q in (-.50,.50) for u,v in profile]
        batch=self.atlas
        first=batch.vertices(points,(1.0,1.0,1.0,1.0))
        swatch=tile_uv(label,True)[0:1]
        count = len(profile)
        for i in range(1, count):
            j = (i + 1) % count
            batch.face(first, (i, j, j + count, i + count), swatch * 4)
        u0,v0=tile_uv(label)[0]
        u1,v1=tile_uv(label)[2]
        batch.face(first, tuple(range(count, count * 2)),
                   tuple((u0 + (u + .5) * (u1 - u0), v0 + v * (v1 - v0)) for u, v in profile))
        batch.face(first, tuple(reversed(range(count))), swatch * count)

    def packed(self,x,y,z,side,label,w,h,kind):
        palette=ATLAS['items'][label]['color']
        if kind=='bottle':
            r=w*.50
            self.tube(x, y, z, [(0, r), (.70*h, r), (.88*h, .46*r), (h, .46*r)], palette,
                      side=side, label=label, sides=6, lid_from=2)
        elif kind in ('cup', 'can'):
            r=w*.54
            taper = .74 if kind == 'cup' else 1
            self.tube(x, y, z, [(0, r*taper), (.88*h, r), (h, r)], palette,
                      side=side, label=label, sides=6, lid_from=1)
        elif kind=='bag':
            self.bag(x, y, z, side, w, h, w*.55, label)
        else:
            along_x=side in ('front','back')
            depth = w * (.58 if kind == 'box' else .85)
            self.box(x, y, z, w if along_x else depth, h, depth if along_x else w,
                     label=label, face=side, on_shelf=True)


def make_material(name,atlas=None,alpha=1.0,emission=0.0):
    material=bpy.data.materials.new(name)
    nodes,links=material.node_tree.nodes,material.node_tree.links
    shader=next(n for n in nodes if n.type=='BSDF_PRINCIPLED')
    shader.inputs['Roughness'].default_value=.8 if alpha==1 else .3
    shader.inputs['Metallic'].default_value=0
    shader.inputs['Alpha'].default_value=alpha
    color=nodes.new('ShaderNodeVertexColor')
    color.layer_name='PropColor'
    if atlas:
        image=nodes.new('ShaderNodeTexImage')
        image.image=atlas
        # glTF reads the texture here and multiplies it by the mesh's COLOR_0.
        links.new(image.outputs['Color'],shader.inputs['Base Color'])
    else:
        links.new(color.outputs['Color'],shader.inputs['Base Color'])
    if emission:
        shader.inputs['Emission Color'].default_value=(.74, .88, .85, 1)
        shader.inputs['Emission Strength'].default_value=emission
    material.use_backface_culling=alpha==1
    return material


ITEM_LINES=(
    (('sea','crisp','rice','castella','mint','sakura','choco'),('bag','bag','box','bag')),
    (('soup','shio','miso','soba','pudding','yogurt','sando'),('cup','cup','box','cup')),
    (('paper','towel','powder','umi','coffee','cocoa','sencha'),('box','box','bag','box')),
)
PRICES=('128','158','198','248','398','468')


def gondola(name,x,index,materials):
    f=Fixture(name,materials)
    label=('tag_snacks','tag_meals','tag_daily')[index]
    accent=(TEAL,BLUSH,METAL)[index]
    center,length=-7.20,5.48
    f.box(x,FLOOR,center,.84,.095,length,INK)
    f.box(x,FLOOR+.09,center,.055,1.37,length-.09,CREAM)
    f.box(x,FLOOR+1.40,center,.43,.065,length-.065,accent)
    for z in (-9.90,-7.20,-4.50):
        for side in (-1,1):
            f.box(x+side*.075,FLOOR+.10,z,.030,1.30,.038,METAL)
    for level,h in enumerate((.13, .415, .70, .985, 1.27)):
        y=FLOOR+h
        for side in (-1,1):
            direction='right' if side>0 else 'left'
            f.box(x+side*.224,y,center,.405,.041,length-.05,PORCELAIN)
            f.box(x+side*.427,y+.005,center,.025,.068,length-.09,accent)
            f.box(x+side*.444,y+.001,center,.012,.028,length-.10,PORCELAIN)
            labels,kinds=ITEM_LINES[(index+(side<0))%len(ITEM_LINES)]
            rng=Random(3000+index*31+level*17+(side>0)*7)
            z=-9.76
            group=0
            while z<-4.69:
                kind=kinds[(group+level)%len(kinds)]
                count = rng.randrange(4, 9)
                product=labels[(group*2+level+(side>0))%len(labels)]
                width = rng.uniform(.076, .119)
                height = rng.uniform(.102, .152) if kind != 'bag' else rng.uniform(.125, .175)
                # Keep the shelf slot pitch while sizing the single-serving pudding.
                package_width, package_height = width, height
                if product == 'pudding':
                    package_width = width * .84
                    package_height = .09 + .40 * (height - .102)
                for i in range(count):
                    if z + width*.52 > -4.51:
                        break
                    f.packed(x + side*(.349 - rng.uniform(0, .027)), y + .042, z,
                             direction, product, package_width, package_height, kind)
                    if i==0:
                        f.box(x+side*.453,y+.019,z,.008,.058,.093,
                              label='price_'+PRICES[(group+level+index)%len(PRICES)],face=direction)
                    z += width + rng.uniform(.012, .027)
                else:
                    group+=1
                    z += .041 + (group%4 == 2)*.045
                    continue
                break
    # End cards are readable from the entrance and the stock-room aisle.
    f.box(x,FLOOR+.11,-4.494,.81,1.20,.070,CREAM)
    f.box(x,FLOOR+.14,-4.453,.77,.11,.024,accent)
    f.box(x,FLOOR+.89,-4.433,.674,.351,.015,label=label,face='front')
    f.box(x,FLOOR+1.01,-9.942,.674,.242,.016,label=label,face='back')
    f.box(x,FLOOR+1.28,-4.462,.83,.045,.04,PORCELAIN)
    f.finish()


DRINKS=('pear','lime','momo','cola','water','barley','sencha','coffee','milk','cocoa','orange','grape')


def coolers(materials):
    f=Fixture('back-drink-coolers',materials)
    x0,z=-1.38,-11.41
    span=5.96
    f.box(x0+span/2,FLOOR,z,span,.078,.746,INK)
    f.box(x0+span/2,FLOOR+.072,-11.744,span,2.405,.09,METAL)
    f.box(x0+span/2,FLOOR+2.38,z,span,.12,.746,CREAM)
    f.box(x0+span/2,FLOOR+2.40,-11.034,span-.045,.067,.021,TEAL)
    f.box(x0+1.35,FLOOR+2.395,-11.026,1.36,.062,.009,label='tag_drinks',face='front')
    bays=5
    w=span/bays
    for bay in range(bays):
        x=x0+w*(bay+.5)
        f.box(x-w/2+.021,FLOOR+.075,z,.042,2.28,.73,CREAM)
        f.box(x,FLOOR+.14,-11.721,w-.075,2.13,.018,'b3cfd2')
        for h in (.125,2.303):
            f.box(x,FLOOR+h,-11.099,w-.043,.044,.081,CREAM)
        f.box(x+w/2-.09,FLOOR+.92,-11.047,.028,.475,.046,INK)
        f.box(x+w/2-.09,FLOOR+1.06,-11.036,.038,.21,.030,METAL)
        f.box(x-w/2+.066,FLOOR+.233,-11.425,.025,2.028,.018,'d9efee',layer='lights')
        for level,h in enumerate((.23, .55, .87, 1.19, 1.53, 1.87)):
            y=FLOOR+h
            f.box(x,y,-11.453,w-.068,.038,.493,'c2d6d1')
            f.box(x,y+.006,-11.201,w-.072,.047,.022,CREAM)
            f.box(x+w*.24,y+.013,-11.184,.10,.034,.014,label='price_'+PRICES[(bay+level)%len(PRICES)])
            for j in range(12):
                label = DRINKS[(level*3 + bay*2 + j//3) % len(DRINKS)]
                if label in ('milk', 'coffee', 'cocoa'):
                    kind, width, height = 'carton', .066, .139
                elif label in ('lime', 'cola', 'orange', 'grape'):
                    kind, width, height = 'can', .061, .106
                else:
                    kind, width, height = 'bottle', .071, .179
                col = x - w/2 + .103 + j*.089
                f.packed(col, y + .038, -11.282, 'front', label, width, height, kind)
        # A single lightly tinted pane leaves the stocked shelves legible.
        f.box(x,FLOOR+.166,-11.074,w-.098,2.115,.006,'cde9ef',layer='glass')
        f.box(x+(.24 if bay%2 else -.22),FLOOR+.194,-11.063,.099,.164,.008,label='cold')
    f.box(x0+span-.021,FLOOR+.075,z,.042,2.28,.73,CREAM)
    f.finish()


def bento_case(materials):
    f=Fixture('back-bento-case',materials)
    center=-3.655
    f.box(center,FLOOR,-11.447,4.07,.084,.695,INK)
    f.box(center,FLOOR+.082,-11.448,4.07,.46,.681,CREAM)
    f.box(center,FLOOR+.105,-11.109,4.035,.097,.017,TEAL)
    f.box(center,FLOOR+.513,-11.710,4.05,.865,.117,METAL)
    f.box(center,FLOOR+1.334,-11.485,4.06,.076,.519,CREAM)
    f.box(center,FLOOR+1.338,-11.213,2.14,.066,.010,label='tag_bento')
    item_rows=(
        ('bento','lunch','bento','lunch'),
        ('salmon','ume','seaweed','sando'),
        ('pudding','yogurt','sando','seaweed'),
    )
    for row,h in enumerate((.575,.81,1.04)):
        y=FLOOR+h
        f.box(center,y,-11.429,4.02,.037,.478,COLD)
        f.box(center,y+.007,-11.185,4.025,.045,.030,INK)
        f.box(center,y+.014,-11.158,4.013,.026,.017,CREAM)
        for i in range(18):
            x = -5.51 + i*.215
            label=item_rows[row][i//3%4]
            if row==0:
                f.box(x, y + .038, -11.381, .182, .043, .142, INK, on_shelf=True)
                f.box(x, y + .080, -11.381, .169, .018, .13, label=label, face='top', on_shelf=True)
            else:
                f.packed(x, y + .038, -11.32, 'front', label, .119, .108, 'box')
            if i%3==0:
                f.box(x,y+.013,-11.143,.1,.033,.008,label='price_'+PRICES[(i//3+row+2)%len(PRICES)])
    for side in (-1,1):
        f.box(center+side*2.019,FLOOR+.562,-11.435,.028,.758,.502,'d6ebdf',layer='glass')
        f.box(center+side*2.019,FLOOR+.46,-11.438,.039,.105,.548,TEAL)
    f.finish()


def checkout(materials):
    f=Fixture('checkout-counter',materials)
    x,z=-4.56,-6.40
    f.box(x,FLOOR,z,.656,.10,4.36,INK)
    f.box(x,FLOOR+.095,z,.627,.841,4.34,CREAM)
    f.box(x+.326,FLOOR+.145,z,.036,.149,4.345,TEAL)
    for i in range(4):
        zz=-8.02+i*1.09
        f.box(x+.324,FLOOR+.325,zz,.023,.563,1.035,'e9e0cb')
        f.box(x+.335,FLOOR+.714,zz,.024,.027,.35,INK)
    f.box(x,FLOOR+.923,z,.679,.102,4.385,INK)
    f.box(x,FLOOR+1.022,z,.673,.025,4.38,'f4e4ca')
    f.box(-4.215,FLOOR+.522,-7.926,.009,.262,.752,label='tag_register',face='right')
    for zz in (-6.82,-4.96):
        f.box(-4.65,FLOOR+1.047,zz,.265,.053,.396,METAL)
        f.box(-4.695,FLOOR+1.098,zz,.16,.067,.292,INK)
        f.box(-4.696,FLOOR+1.161,zz,.044,.212,.304,INK)
        f.box(-4.668,FLOOR+1.182,zz,.014,.163,.262,label='pos',face='right')
        f.box(-4.355,FLOOR+1.047,zz+.218,.143,.080,.187,INK)
        f.box(-4.355,FLOOR+1.126,zz+.218,.115,.012,.153,label='terminal',face='top')
        f.box(-4.302,FLOOR+1.047,zz-.195,.154,.012,.246,'819aa1')
        f.box(-4.302,FLOOR+1.059,zz-.195,.129,.004,.211,'394849')
        for i in range(4):
            f.box(-4.694,FLOOR+1.167,zz-.076+i*.050,.017,.016,.021,'bfcebe')
    # Counter warmer and small, visible pastry silhouettes.
    cx,cz=-4.538,-8.024
    f.box(cx,FLOOR+1.047,cz,.561,.045,.955,INK)
    f.box(cx,FLOOR+1.443,cz,.559,.043,.947,'d9a368')
    f.box(cx,FLOOR+1.441,cz,.081,.056,.779,'f2d49c',layer='lights')
    for side in (-1,1):
        f.box(cx+side*.257,FLOOR+1.083,cz,.020,.36,.931,'eff0d5',layer='glass')
        f.box(cx,FLOOR+1.083,cz+side*.459,.527,.36,.018,'eff0d5',layer='glass')
    f.box(cx+.270,FLOOR+1.188,cz-.20,.012,.069,.229,label='warm',face='right')
    for j in range(4):
        for i in range(2):
            f.tube(cx-.116+i*.221,FLOOR+1.094,cz-.322+j*.209,
                   [(0,.067),(.028,.074),(.063,.062),(.076,.044)],
                   ('b98150','db9b5d','e4b577','c78243')[j],sides=8)
    # Small price display and coffee section at the entrance end.
    f.box(-4.55,FLOOR+1.05,-4.503,.426,.228,.35,'6b5953')
    f.box(-4.551,FLOOR+1.22,-4.498,.437,.06,.341,INK)
    f.box(-4.322,FLOOR+1.11,-4.503,.010,.099,.187,label='coffee_menu',face='right')
    f.finish()


def magazine_rack(materials):
    f=Fixture('magazine-rack',materials)
    x,z=4.15,-3.04
    f.box(x,FLOOR,z,2.78,.085,.429,INK)
    f.box(x,FLOOR+.08,-2.833,2.77,1.40,.047,METAL)
    f.box(x,FLOOR+1.45,-2.98,2.782,.055,.283,CREAM)
    magazines=('coast','city','trail','craft','night','home','garden','read')
    for level,h in enumerate((.165,.45,.74,1.035)):
        y=FLOOR+h
        f.box(x,y,-3.022,2.705,.039,.356,'dccbad')
        f.box(x,y+.019,-3.251,2.728,.072,.023,TEAL)
        for col in range(10):
            label=magazines[(col+level*3)%len(magazines)]
            z0=-3.177+(col%3-1)*.009
            by=y+.044
            f.box(2.916+col*.271,by,z0,.215,.254+(col%2)*.014,.039,label=label,face='back',tilt=.082)
            if col%4==2:
                f.box(2.916+col*.271,by+.006,z0+.025,.209,.250,.014,'f1dec0',tilt=.082)
    for side in (-1,1):
        f.box(x+side*1.363,FLOOR+.084,z,.053,1.38,.382,RIM)
    f.box(x,FLOOR+1.389,-3.19,.695,.116,.019,label='tag_read',face='back')
    f.finish()


def export_glb():
    bpy.ops.export_scene.gltf(
        filepath=str(ROOT / 'konbini-interior.glb'),
        export_format='GLB',
        export_yup=True,
        export_vertex_color='ACTIVE',
        export_apply=True,
    )


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.name='Hidamari W1 fixture inventory'
    atlas=bpy.data.images.load(str(ROOT/'konbini-packages.png'))
    atlas.pack()
    mats={
        'paint':make_material('Hidamari painted stock and fixtures'),
        'labels':make_material('Hidamari printed package atlas',atlas=atlas),
        'glass':make_material('Hidamari thin cabinet glass',alpha=.10),
        'lights':make_material('Hidamari frosted strip light',emission=.38),
    }
    for index,x in enumerate((-2.65,-.20,2.30)):
        gondola(f'gondola-{"abc"[index]}',x,index,mats)
    coolers(mats)
    bento_case(mats)
    checkout(mats)
    magazine_rack(mats)
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type=='VIEW_3D':
                viewport = area.spaces.active
                viewport.shading.color_type = 'VERTEX'
                viewport.region_3d.view_location = (0, 7, 1)
                viewport.region_3d.view_distance = 19
                viewport.region_3d.view_rotation = Vector((8, -11, 7)).to_track_quat('Z', 'Y')
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / 'konbini-interior.blend'))


if '--export-only' not in sys.argv:
    build()
export_glb()
