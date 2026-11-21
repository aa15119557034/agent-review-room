# build-pole-v2.py —— 电线杆 + 电线（C酱 2026-11-21 反馈：参考图里日本街道电线杆是画面主角）
# 要点：2~3 层横担、柱上变压器罐、脚钉、底部黄黑护套、柱身小广告牌、成捆线缆带垂度 + 引下线
import bpy, bmesh, math, os, json, random
from mathutils import Vector

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'poles')


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat(name, rgb, rough=0.85, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    return m


def new_obj(name, material, bm, smooth=True):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = smooth
    me.materials.append(material)
    return ob


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def taper(bm, p0, p1, r0, r1, seg=8):
    d = Vector(p1) - Vector(p0)
    L = d.length
    if L < 1e-5:
        return
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r0, radius2=r1, depth=L)
    quat = Vector((0, 0, 1)).rotation_difference(d.normalized())
    mid = Vector(p0) + d * 0.5
    for v in res['verts']:
        v.co = quat @ v.co + mid


def box(bm, cx, cy, cz, sx, sy, sz):
    vs = []
    for dz in (-0.5, 0.5):
        for dy in (-0.5, 0.5):
            for dx in (-0.5, 0.5):
                vs.append(bm.verts.new((cx + dx * sx, cy + dy * sy, cz + dz * sz)))
    bm.verts.ensure_lookup_table()
    idx = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    for a, b, c, d in idx:
        bm.faces.new((vs[a], vs[b], vs[c], vs[d]))


def cyl(bm, cx, cy, cz, r0, r1, h, seg=8, caps=True):
    res = bmesh.ops.create_cone(bm, cap_ends=caps, segments=seg, radius1=r0, radius2=r1, depth=h)
    for v in res['verts']:
        v.co.x += cx
        v.co.y += cy
        v.co.z += cz + h / 2


def build_pole(variant='a'):
    """电柱：混凝土杆 + 3 层横担 + 绝缘子 + 变压器 + 脚钉 + 黄黑护套 + 广告牌"""
    M = dict(
        concrete=mat('concrete', (0.58, 0.58, 0.56), 0.95),
        steel=mat('steel', (0.26, 0.28, 0.30), 0.5, 0.7),
        dark=mat('dark', (0.13, 0.14, 0.16), 0.7),
        white=mat('white', (0.88, 0.88, 0.86), 0.8),
        yellow=mat('yellow', (0.92, 0.74, 0.12), 0.7),
        black=mat('black', (0.10, 0.10, 0.11), 0.8),
        red=mat('red', (0.70, 0.16, 0.14), 0.7),
        ad=mat('ad', (0.90, 0.88, 0.80), 0.9),
    )
    objs = []
    H = 11.0 if variant == 'a' else 12.0

    # 杆身（锥度）+ 底座
    bm = bmesh.new()
    taper(bm, (0, 0, 0), (0, 0, H), 0.20, 0.13, 10)
    cyl(bm, 0, 0, 0, 0.28, 0.28, 0.20, 10)
    objs.append(new_obj('pole-shaft', M['concrete'], bm))

    # 横担 3 层（顶两层 + 一层低位）
    arms = [(H - 0.45, 2.2, 3), (H - 1.35, 1.9, 3), (H - 2.35, 1.5, 2)] if variant == 'a' \
        else [(H - 0.40, 2.4, 3), (H - 1.20, 2.1, 3), (H - 2.10, 1.7, 3), (H - 3.00, 1.3, 2)]
    bm = bmesh.new()
    for z, w, n in arms:
        box(bm, 0, 0, z, w, 0.10, 0.10)
        box(bm, 0, 0, z + 0.14, w * 0.92, 0.06, 0.05)   # 上层加强条
    objs.append(new_obj('pole-arms', M['steel'], bm))

    # 绝缘子
    bm = bmesh.new()
    for z, w, n in arms:
        for i in range(n):
            x = -w * 0.40 + i * (w * 0.80 / max(1, n - 1))
            cyl(bm, x, 0, z + 0.06, 0.055, 0.045, 0.20, 6)
    objs.append(new_obj('pole-insulators', M['white'], bm))

    # 柱上变压器罐（带托架）
    bm = bmesh.new()
    cyl(bm, 0.34, 0, H - 4.5, 0.30, 0.30, 0.85, 10)
    cyl(bm, 0.34, 0, H - 4.5 + 0.85, 0.16, 0.16, 0.12, 8)
    objs.append(new_obj('pole-transformer', M['dark'], bm))
    bm = bmesh.new()
    box(bm, 0.17, 0, H - 4.5 + 0.42, 0.36, 0.08, 0.08)
    box(bm, 0.17, 0, H - 4.5 - 0.06, 0.36, 0.08, 0.08)
    objs.append(new_obj('pole-bracket', M['steel'], bm))

    # 脚钉（左右交替）
    bm = bmesh.new()
    for i in range(9):
        z = 1.4 + i * 0.55
        side = 1 if i % 2 == 0 else -1
        cyl(bm, side * 0.16, 0, z, 0.018, 0.018, 0.16, 4)
    objs.append(new_obj('pole-steps', M['steel'], bm))

    # 底部黄黑警示护套
    bm = bmesh.new()
    for i in range(5):
        cyl(bm, 0, 0, 0.20 + i * 0.24, 0.235, 0.235, 0.12, 10)
    objs.append(new_obj('pole-sleeve-y', M['yellow'], bm))
    bm = bmesh.new()
    for i in range(5):
        cyl(bm, 0, 0, 0.32 + i * 0.24, 0.238, 0.238, 0.12, 10)
    objs.append(new_obj('pole-sleeve-k', M['black'], bm))

    # 柱身小广告牌
    bm = bmesh.new()
    box(bm, 0, -0.20, 2.9, 0.36, 0.05, 0.52)
    objs.append(new_obj('pole-ad', M['ad'], bm, smooth=False))
    bm = bmesh.new()
    box(bm, 0, -0.235, 3.05, 0.30, 0.02, 0.10)
    objs.append(new_obj('pole-ad-stripe', M['red'], bm, smooth=False))

    # 抱箍
    bm = bmesh.new()
    for z in (3.3, 5.2, H - 2.9):
        cyl(bm, 0, 0, z, 0.195, 0.195, 0.10, 10)
    objs.append(new_obj('pole-bands', M['steel'], bm))
    return objs


def build_wire_bundle(span=25.0, sag=0.85, seed=1, drops=2):
    """一跨线缆：6 根不同粗细 + 2 根引下线"""
    rnd = random.Random(seed)
    m = mat('cable', (0.10, 0.10, 0.12), 0.6)
    bm = bmesh.new()
    # 主缆：3 个高度 x 2 根
    specs = [(-1.05, 10.55, 0.030), (0.0, 10.55, 0.030), (1.05, 10.55, 0.030),
             (-0.80, 9.65, 0.022), (0.80, 9.65, 0.022),
             (0.0, 8.65, 0.018)]
    seg = 12
    for (dx, z0, r) in specs:
        pts = []
        for i in range(seg + 1):
            t = i / seg
            x = -span / 2 + span * t
            z = z0 - sag * math.sin(math.pi * t) * (0.8 + r * 4)
            pts.append((x, dx, z))
        rings = []
        for (x, y, z) in pts:
            ring = []
            for a in range(4):
                ang = 2 * math.pi * a / 4
                ring.append(bm.verts.new((x, y + math.cos(ang) * r, z + math.sin(ang) * r)))
            rings.append(ring)
        for i in range(len(rings) - 1):
            for a in range(4):
                b = (a + 1) % 4
                bm.faces.new((rings[i][a], rings[i][b], rings[i + 1][b], rings[i + 1][a]))
    # 引下线：从杆顶斜拉到侧面（接到房子）
    for k in range(drops):
        y0 = (k - 0.5) * 0.8
        pts = [(-span * 0.4, y0, 9.4 - k * 0.5),
               (-span * 0.1, y0 + 1.6, 8.2),
               (span * 0.18, y0 + 3.0, 6.4)]
        r = 0.016
        rings = []
        for (x, y, z) in pts:
            ring = []
            for a in range(4):
                ang = 2 * math.pi * a / 4
                ring.append(bm.verts.new((x, y + math.cos(ang) * r, z + math.sin(ang) * r)))
            rings.append(ring)
        for i in range(len(rings) - 1):
            for a in range(4):
                b = (a + 1) % 4
                bm.faces.new((rings[i][a], rings[i][b], rings[i + 1][b], rings[i + 1][a]))
    return [new_obj('wire-bundle', m, bm)]


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
    ('pole-utility-a', lambda: build_pole('a')),
    ('pole-utility-b', lambda: build_pole('b')),
    ('wire-bundle', lambda: build_wire_bundle()),
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

with open(os.path.join(OUT, 'pole-report.json'), 'w', encoding='utf-8') as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print('DONE')
