# build-vegetation.py —— 风格化植被包（C酱 2026-11-21 交接第 4 项，提到第二位）
# 目标：主街以外的大片空草地（中层楼近景里看到的那种）需要低模树/灌木/草簇。
import bpy, bmesh, math, os, json, random
from mathutils import Vector

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'vegetation')


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat(name, rgb, rough=0.9):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = 0.0
    return m


M = {}


def pal():
    """每次 reset 之后重建材质（read_factory_settings 会把数据块清掉）"""
    M.clear()
    M['bark'] = mat('bark', (0.26, 0.20, 0.16), 0.95)
    M['bark_light'] = mat('bark_light', (0.36, 0.29, 0.22), 0.95)
    M['leaf_dark'] = mat('leaf_dark', (0.13, 0.29, 0.16), 0.92)
    M['leaf_mid'] = mat('leaf_mid', (0.19, 0.38, 0.19), 0.92)
    M['leaf_light'] = mat('leaf_light', (0.27, 0.46, 0.22), 0.92)
    M['conifer'] = mat('conifer', (0.10, 0.24, 0.16), 0.93)
    M['cherry'] = mat('cherry', (0.94, 0.68, 0.76), 0.90)
    M['cherry_deep'] = mat('cherry_deep', (0.88, 0.56, 0.68), 0.90)
    M['hedge'] = mat('hedge', (0.16, 0.32, 0.17), 0.93)
    M['grass'] = mat('grass', (0.30, 0.47, 0.20), 0.95)


def new_obj(name, material, bm):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    return ob


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def ico(bm, cx, cy, cz, r, subdiv=1, sx=1.0, sy=1.0, sz=1.0):
    res = bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=r)
    for v in res['verts']:
        v.co.x = v.co.x * sx + cx
        v.co.y = v.co.y * sy + cy
        v.co.z = v.co.z * sz + cz
    return res['verts']


def cone(bm, cx, cy, cz, r0, r1, h, seg=6):
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg,
                                radius1=r0, radius2=r1, depth=h)
    for v in res['verts']:
        v.co.x += cx
        v.co.y += cy
        v.co.z += cz + h / 2
    return res['verts']


def export(objs, name):
    for ob in bpy.context.scene.objects:
        ob.select_set(False)
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, name + '.glb')
    bpy.ops.export_scene.gltf(filepath=p, export_format='GLB', use_selection=True,
                              export_apply=True, export_yup=True)
    return p


def tree_broadleaf(variant):
    rnd = random.Random(17 + (0 if variant == 'a' else 1))
    H = 6.6 if variant == 'a' else 7.4
    out = []
    bm = bmesh.new()
    cone(bm, 0, 0, 0, 0.30, 0.17, H * 0.52, 6)
    for i in range(3):
        a = math.radians(360 * i / 3 + rnd.uniform(-20, 20))
        cone(bm, math.cos(a) * 0.55, math.sin(a) * 0.55, H * 0.30, 0.13, 0.06, H * 0.30, 5)
    out.append(new_obj('trunk', M['bark'], bm))

    bm = bmesh.new()
    base = H * 0.55
    ico(bm, 0, 0, base + 1.0, 2.05, 1, 1.0, 1.0, 0.92)
    for i in range(3):
        a = math.radians(120 * i + rnd.uniform(-25, 25))
        d = rnd.uniform(1.25, 1.75)
        ico(bm, math.cos(a) * d, math.sin(a) * d, base + rnd.uniform(0.2, 0.7), 1.35, 1, 1.0, 1.0, 0.78)
    out.append(new_obj('canopy', M['leaf_dark'] if variant == 'a' else M['leaf_mid'], bm))

    bm = bmesh.new()
    ico(bm, 0, 0, base + 2.1, 1.35, 1, 1.0, 1.0, 0.7)
    out.append(new_obj('canopy-top', M['leaf_light'], bm))
    return out


def tree_cherry():
    out = []
    bm = bmesh.new()
    cone(bm, 0, 0, 0, 0.26, 0.15, 3.0, 6)
    for i in range(3):
        a = math.radians(120 * i + 12)
        cone(bm, math.cos(a) * 0.7, math.sin(a) * 0.7, 2.4, 0.11, 0.05, 1.5, 5)
    out.append(new_obj('trunk', M['bark_light'], bm))
    bm = bmesh.new()
    for (x, y, z, r) in [(0, 0, 4.1, 2.3), (1.5, 0.6, 3.7, 1.5), (-1.4, -0.8, 3.8, 1.45), (0.3, -1.6, 3.9, 1.3)]:
        ico(bm, x, y, z, r, 1, 1.0, 1.0, 0.62)
    out.append(new_obj('canopy', M['cherry'], bm))
    bm = bmesh.new()
    ico(bm, 0, 0, 4.75, 1.7, 1, 1.0, 1.0, 0.55)
    out.append(new_obj('canopy-top', M['cherry_deep'], bm))
    return out


def tree_conifer():
    H = 9.0
    out = []
    bm = bmesh.new()
    cone(bm, 0, 0, 0, 0.26, 0.14, H * 0.30, 6)
    out.append(new_obj('trunk', M['bark'], bm))
    bm = bmesh.new()
    for (z, r, h) in [(H * 0.18, 1.85, H * 0.42), (H * 0.46, 1.42, H * 0.36), (H * 0.70, 0.95, H * 0.30)]:
        cone(bm, 0, 0, z, r, 0.05, h, 7)
    out.append(new_obj('canopy', M['conifer'], bm))
    return out


def tree_young():
    out = []
    bm = bmesh.new()
    cone(bm, 0, 0, 0, 0.10, 0.07, 2.3, 5)
    out.append(new_obj('trunk', M['bark_light'], bm))
    bm = bmesh.new()
    ico(bm, 0, 0, 2.85, 0.85, 1, 1.0, 1.0, 0.85)
    out.append(new_obj('canopy', M['leaf_mid'], bm))
    return out


def bush(variant):
    r = 0.85 if variant == 'a' else 1.15
    bm = bmesh.new()
    if variant == 'a':
        ico(bm, 0, 0, r * 0.72, r, 1, 1.0, 1.0, 0.85)
    else:
        ico(bm, -0.45, 0.15, r * 0.62, r * 0.72, 1, 1.0, 1.0, 0.8)
        ico(bm, 0.55, -0.1, r * 0.55, r * 0.62, 1, 1.0, 1.0, 0.8)
        ico(bm, 0.05, 0.5, r * 0.70, r * 0.58, 1, 1.0, 1.0, 0.8)
    return [new_obj('bush', M['hedge'], bm)]


def hedge_seg():
    bm = bmesh.new()
    ico(bm, -0.5, 0, 0.42, 0.62, 1, 1.25, 0.9, 0.75)
    ico(bm, 0.5, 0, 0.42, 0.62, 1, 1.25, 0.9, 0.75)
    return [new_obj('hedge', M['hedge'], bm)]


def grass_tuft():
    bm = bmesh.new()
    for i in range(5):
        a = math.radians(72 * i)
        dx, dy = math.cos(a) * 0.10, math.sin(a) * 0.10
        px, py = -math.sin(a) * 0.16, math.cos(a) * 0.16
        pts = [(dx - px, dy - py, 0.0), (dx + px, dy + py, 0.0),
               (dx + px * 0.35 + dx * 0.4, dy + py * 0.35 + dy * 0.4, 0.45),
               (dx - px * 0.35 + dx * 0.4, dy - py * 0.35 + dy * 0.4, 0.45)]
        vs = [bm.verts.new(p) for p in pts]
        bm.faces.new((vs[0], vs[1], vs[2], vs[3]))
    return [new_obj('grass', M['grass'], bm)]


BUILDS = [
    ('veg-tree-broadleaf-a', lambda: tree_broadleaf('a')),
    ('veg-tree-broadleaf-b', lambda: tree_broadleaf('b')),
    ('veg-tree-cherry', tree_cherry),
    ('veg-tree-conifer', tree_conifer),
    ('veg-tree-young', tree_young),
    ('veg-bush-a', lambda: bush('a')),
    ('veg-bush-b', lambda: bush('b')),
    ('veg-hedge-seg', hedge_seg),
    ('veg-grass-tuft', grass_tuft),
]

report = []
for name, fn in BUILDS:
    reset()
    pal()
    objs = fn()
    tris = sum(tri_count(o) for o in objs)
    xs, ys, zs = [], [], []
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            xs.append(w.x); ys.append(w.y); zs.append(w.z)
    size = [round(max(xs) - min(xs), 2), round(max(ys) - min(ys), 2), round(max(zs) - min(zs), 2)]
    p = export(objs, name)
    report.append({'file': name + '.glb', 'triangles': tris, 'bytes': os.path.getsize(p), 'size_m': size})
    flag = '  !! >400 tris' if tris > 400 else ''
    print('EXPORT', name, tris, 'tris', '%.2fx%.2fx%.2f' % tuple(size), flag)

with open(os.path.join(OUT, 'veg-report.json'), 'w', encoding='utf-8') as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print('DONE')
