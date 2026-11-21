# build-grass-v2.py —— 草簇 / 花簇（C酱 2026-11-21 反馈：要带透明贴图和渐变色）
# 做法和树一致：alpha 卡为主体，顶点色做根部暗、尖端亮的渐变。
import bpy, bmesh, math, os, json, random
from mathutils import Vector

TEX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'vegtex')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'grass')


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mk_mat_card(name, texfile, alpha_uv=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(os.path.join(TEX, texfile), check_existing=True)
    tex.interpolation = 'Linear'
    uv = nt.nodes.new('ShaderNodeUVMap')
    nt.links.new(uv.outputs['UV'], tex.inputs['Vector'])
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Col'
    mix = nt.nodes.new('ShaderNodeMixRGB')
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Fac'].default_value = 1.0
    nt.links.new(tex.outputs['Color'], mix.inputs['Color1'])
    nt.links.new(vc.outputs['Color'], mix.inputs['Color2'])
    nt.links.new(mix.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(tex.outputs['Alpha'], b.inputs['Alpha'])
    b.inputs['Roughness'].default_value = 0.9
    try:
        m.surface_render_method = 'DITHERED'
    except Exception:
        pass
    try:
        m.blend_method = 'CLIP'
        m.alpha_threshold = 0.4
    except Exception:
        pass
    m.use_backface_culling = False
    return m


def mesh_from_bm(name, mat, bm):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    me.materials.append(mat)
    return ob


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def add_quad(bm, uv_layer, col_layer, p, a1, a2, uv_rect, c_low, c_high):
    quad = [p - a1 - a2, p + a1 - a2, p + a1 + a2, p - a1 + a2]
    vs = [bm.verts.new(q) for q in quad]
    # 下沿暗、上沿亮
    vs[0][col_layer] = (*c_low, 1.0)
    vs[1][col_layer] = (*c_low, 1.0)
    vs[2][col_layer] = (*c_high, 1.0)
    vs[3][col_layer] = (*c_high, 1.0)
    f = bm.faces.new(vs)
    rx0, ry0, rx1, ry1 = uv_rect
    for loop, uv in zip(f.loops, [(rx0, ry0), (rx1, ry0), (rx1, ry1), (rx0, ry1)]):
        loop[uv_layer].uv = uv
    return f


def grass_clump(seed, height=0.75, cards=7, spread=0.28):
    rnd = random.Random(seed)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.verify()
    col_layer = bm.verts.layers.float_color.new('Col')
    c_low = (0.42, 0.46, 0.38)      # 根：偏暗偏灰
    c_high = (1.18, 1.20, 0.92)     # 尖：提亮偏暖
    for i in range(cards):
        a = 2 * math.pi * i / cards + rnd.uniform(-0.25, 0.25)
        lean = rnd.uniform(0.10, 0.30)
        cx = math.cos(a) * rnd.uniform(0, spread)
        cy = math.sin(a) * rnd.uniform(0, spread)
        h = height * rnd.uniform(0.72, 1.15)
        w = h * rnd.uniform(0.42, 0.62)
        # 面片：底边在地面，向上稍微倾斜、朝外
        base = Vector((cx, cy, 0.0))
        up = Vector((math.cos(a) * lean, math.sin(a) * lean, 1.0)).normalized()
        side = Vector((-math.sin(a), math.cos(a), 0.0)).normalized()
        a1 = side * (w * 0.5)
        a2 = up * (h * 0.5)
        p = base + up * (h * 0.5)
        rx0, ry0, rx1, ry1 = (0.0, 0.30, 1.0, 1.0)   # 草叶图下半部有效
        add_quad(bm, uv_layer, col_layer, p, a1, a2, (rx0, ry0, rx1, ry1), c_low, c_high)
    return [mesh_from_bm('grass-clump', mk_mat_card('grasscard', 'grass-atlas.png'), bm)]


def flower_clump(seed, color_row, height=0.55, cards=6):
    """草叶 + 几片花卡（花的 UV 取 flower-atlas 对应行）"""
    rnd = random.Random(seed)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.verify()
    col_layer = bm.verts.layers.float_color.new('Col')
    c_low = (0.45, 0.50, 0.40)
    c_high = (1.15, 1.18, 0.95)
    for i in range(cards):
        a = 2 * math.pi * i / cards + rnd.uniform(-0.3, 0.3)
        h = height * rnd.uniform(0.7, 1.1)
        w = h * 0.55
        base = Vector((math.cos(a) * rnd.uniform(0, 0.16), math.sin(a) * rnd.uniform(0, 0.16), 0.0))
        up = Vector((math.cos(a) * 0.22, math.sin(a) * 0.22, 1.0)).normalized()
        side = Vector((-math.sin(a), math.cos(a), 0.0)).normalized()
        p = base + up * (h * 0.5)
        add_quad(bm, uv_layer, col_layer, p, side * (w * 0.5), up * (h * 0.5),
                 (0.0, 0.30, 1.0, 1.0), c_low, c_high)
    # 花：3 片小卡，取对应颜色行
    row = 1.0 - (color_row + 0.5) / 3.0
    for i in range(3):
        a = rnd.uniform(0, 2 * math.pi)
        hh = height * rnd.uniform(0.55, 0.85)
        cw = hh * 0.55
        base = Vector((math.cos(a) * rnd.uniform(0, 0.22), math.sin(a) * rnd.uniform(0, 0.22), 0.0))
        up = Vector((math.cos(a) * 0.18, math.sin(a) * 0.18, 1.0)).normalized()
        side = Vector((-math.sin(a), math.cos(a), 0.0)).normalized()
        p = base + up * hh
        cell = rnd.randrange(4)
        u0 = cell / 4.0
        u1 = (cell + 1) / 4.0
        v0 = row - 0.30
        v1 = row + 0.30
        add_quad(bm, uv_layer, col_layer, p, side * cw, up * (cw * 0.9),
                 (u0, max(0.0, v0), u1, min(1.0, v1)), (1.0, 1.0, 1.0), (1.15, 1.15, 1.15))
    return [mesh_from_bm('flower-clump', mk_mat_card('flowercard', 'flower-atlas.png'), bm)]


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


BUILDS = [
    ('grass-clump-a', lambda: grass_clump(1, 0.75, 7, 0.28)),
    ('grass-clump-b', lambda: grass_clump(5, 0.95, 9, 0.34)),
    ('flower-white', lambda: flower_clump(11, 0)),
    ('flower-yellow', lambda: flower_clump(12, 1)),
    ('flower-pink', lambda: flower_clump(13, 2)),
]

report = []
for name, fn in BUILDS:
    reset()
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
    print('EXPORT', name, tris, 'tris', '%.2fx%.2fx%.2f' % tuple(size))

with open(os.path.join(OUT, 'grass-report.json'), 'w', encoding='utf-8') as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print('DONE')
