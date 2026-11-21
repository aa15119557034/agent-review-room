# build-street-props.py —— 街道道具包（C酱 2026-11-21 交接第 3 项）
# 输出到 out/props/，尺寸单位米，Y-up 导出，平面着色材质，三角面尽量省。
import bpy, bmesh, math, os, json, sys
from mathutils import Vector, Matrix

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'props')


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat(name, rgb, rough=0.85, metal=0.0, emit=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1.0)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1.0)
        b.inputs['Emission Strength'].default_value = 1.2
    return m


def box(bm, cx, cy, cz, sx, sy, sz):
    vs = []
    for dz in (-0.5, 0.5):
        for dy in (-0.5, 0.5):
            for dx in (-0.5, 0.5):
                vs.append(bm.verts.new((cx + dx * sx, cy + dy * sy, cz + dz * sz)))
    bm.verts.ensure_lookup_table()
    idx = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return [bm.faces.new((vs[a], vs[b], vs[c], vs[d])) for a, b, c, d in idx]


def cyl(bm, cx, cy, cz, r0, r1, h, seg=8, cap=True):
    """竖直圆柱/圆台，底面在 cz"""
    bot, top = [], []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        bot.append(bm.verts.new((cx + math.cos(a) * r0, cy + math.sin(a) * r0, cz)))
        top.append(bm.verts.new((cx + math.cos(a) * r1, cy + math.sin(a) * r1, cz + h)))
    f = []
    for i in range(seg):
        j = (i + 1) % seg
        f.append(bm.faces.new((bot[i], bot[j], top[j], top[i])))
    if cap:
        f.append(bm.faces.new(list(reversed(bot))))
        if r1 > 1e-4:
            f.append(bm.faces.new(top))
    return f


def disc(bm, cx, cy, cz, r, seg=16, axis='Y'):
    """竖直面片（轴对齐），用于标牌正面"""
    vs = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        if axis == 'Y':
            vs.append(bm.verts.new((cx + math.cos(a) * r, cy, cz + math.sin(a) * r)))
        else:
            vs.append(bm.verts.new((cx, cy + math.cos(a) * r, cz + math.sin(a) * r)))
    return [bm.faces.new(vs)]


def quad(bm, pts):
    return [bm.faces.new([bm.verts.new(p) for p in pts])]


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


def export(objs, name, folder):
    for ob in bpy.context.scene.objects:
        ob.select_set(False)
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    os.makedirs(folder, exist_ok=True)
    p = os.path.join(folder, name + '.glb')
    bpy.ops.export_scene.gltf(filepath=p, export_format='GLB', use_selection=True,
                              export_apply=True, export_yup=True)
    return p


# ---------------------------------------------------------------- 材质
def M():
    return dict(
        concrete=mat('concrete', (0.62, 0.62, 0.60), 0.95),
        metal=mat('metal', (0.30, 0.32, 0.35), 0.55, 0.6),
        dark=mat('dark', (0.16, 0.17, 0.20), 0.7),
        white=mat('white', (0.90, 0.90, 0.88), 0.8),
        red=mat('red', (0.72, 0.14, 0.13), 0.6),
        blue=mat('blue', (0.10, 0.28, 0.55), 0.6),
        yellow=mat('yellow', (0.92, 0.72, 0.12), 0.6),
        green=mat('green', (0.13, 0.42, 0.26), 0.6),
        glass=mat('glass', (0.70, 0.82, 0.88), 0.25, 0.1),
        cream=mat('cream', (0.85, 0.80, 0.70), 0.8),
    )


def build_pole(variant):
    """電柱：A = 基本，B = 带变压器 + 双横担"""
    m = M()
    objs = []
    bm = bmesh.new()
    cyl(bm, 0, 0, 0, 0.17, 0.11, 9.0, 8)          # 杆身
    cyl(bm, 0, 0, 0, 0.24, 0.24, 0.12, 8)         # 底座
    objs.append(new_obj('pole-body', m['concrete'], bm))

    bm = bmesh.new()
    arms = [(8.15, 1.9), (7.35, 1.5)] if variant == 'b' else [(8.15, 1.9)]
    for z, w in arms:
        box(bm, 0, 0, z, w, 0.09, 0.09)
    if variant == 'b':
        box(bm, 0, 0.30, 6.45, 0.10, 0.62, 0.10)  # 变压器托架
    objs.append(new_obj('pole-arms', m['metal'], bm))

    bm = bmesh.new()
    for z, w in arms:
        n = 3
        for i in range(n):
            x = -w * 0.42 + i * (w * 0.84 / (n - 1))
            cyl(bm, x, 0, z + 0.045, 0.045, 0.045, 0.13, 6)
    objs.append(new_obj('pole-insulators', m['white'], bm))

    if variant == 'b':
        bm = bmesh.new()
        cyl(bm, 0, 0.52, 6.10, 0.26, 0.26, 0.70, 8)   # 柱上变压器
        objs.append(new_obj('pole-transformer', m['dark'], bm))
    return objs


def build_wire_span(span=20.0, sag=0.55):
    """一跨电线：3 根悬链线，4 边管"""
    m = M()
    bm = bmesh.new()
    seg = 10
    for k, (dx, z) in enumerate([(-0.8, 8.20), (0.0, 8.20), (0.8, 8.20)]):
        pts = []
        for i in range(seg + 1):
            t = i / seg
            x = -span / 2 + span * t
            y = z - sag * math.sin(math.pi * t)
            pts.append((x, dx, y))
        r = 0.022
        rings = []
        for (x, y, zz) in pts:
            ring = [bm.verts.new((x, y + math.cos(2 * math.pi * a / 4) * r,
                                  zz + math.sin(2 * math.pi * a / 4) * r)) for a in range(4)]
            rings.append(ring)
        for i in range(len(rings) - 1):
            for a in range(4):
                b = (a + 1) % 4
                bm.faces.new((rings[i][a], rings[i][b], rings[i + 1][b], rings[i + 1][a]))
    return [new_obj('wire-span', m['dark'], bm)]


def build_vending(kind):
    """自動販売機 1.00 x 0.72 x 1.85"""
    m = M()
    W, D, H = 1.00, 0.72, 1.85
    body_col = m['red'] if kind == 'drinks' else m['dark']
    objs = []
    bm = bmesh.new()
    box(bm, 0, 0, H / 2, W, D, H)
    objs.append(new_obj('vending-body', body_col, bm))

    bm = bmesh.new()
    box(bm, 0, -D / 2 - 0.01, H * 0.66, W * 0.86, 0.03, H * 0.42)   # 展示窗
    objs.append(new_obj('vending-window', m['glass'], bm))

    bm = bmesh.new()
    for i in range(3):                                              # 样品行
        box(bm, 0, -D / 2 - 0.03, H * 0.52 + i * 0.135, W * 0.82, 0.04, 0.09)
    objs.append(new_obj('vending-shelves', m['cream'], bm))

    bm = bmesh.new()
    box(bm, 0, -D / 2 - 0.02, H * 0.20, W * 0.72, 0.04, 0.22)       # 取货口
    box(bm, W * 0.30, -D / 2 - 0.02, H * 0.36, 0.16, 0.03, 0.12)     # 投币
    objs.append(new_obj('vending-panel', m['metal'] if kind == 'drinks' else m['cream'], bm))

    bm = bmesh.new()
    box(bm, 0, -D / 2 - 0.005, H * 0.90, W * 0.94, 0.02, 0.11)       # 顶部灯带
    objs.append(new_obj('vending-light', m['white'] if kind == 'drinks' else m['yellow'], bm))
    return objs


def build_postbox():
    """郵便ポスト：直径 0.56，高 1.15"""
    m = M()
    objs = []
    bm = bmesh.new()
    cyl(bm, 0, 0, 0.10, 0.30, 0.30, 0.85, 10)
    cyl(bm, 0, 0, 0, 0.20, 0.20, 0.10, 10)
    objs.append(new_obj('postbox-body', m['red'], bm))
    bm = bmesh.new()
    cyl(bm, 0, 0, 0.95, 0.30, 0.16, 0.16, 10)                        # 圆顶
    objs.append(new_obj('postbox-cap', m['red'], bm))
    bm = bmesh.new()
    box(bm, 0, -0.26, 0.82, 0.30, 0.06, 0.05)                        # 投递口
    objs.append(new_obj('postbox-slot', m['dark'], bm))
    return objs


def build_sign(kind):
    """路牌：speed(限速圆) / blue(方向牌) / warning(菱形) / stop(止まれ)"""
    m = M()
    post_h = {'speed': 2.4, 'blue': 2.6, 'warning': 2.3, 'stop': 2.2}[kind]
    objs = []
    bm = bmesh.new()
    cyl(bm, 0, 0, 0, 0.045, 0.040, post_h, 6)
    objs.append(new_obj('sign-post', m['metal'], bm))

    if kind == 'speed':
        bm = bmesh.new()
        disc(bm, 0, 0, post_h, 0.31, 16)
        objs.append(new_obj('sign-face', m['white'], bm))
        bm = bmesh.new()
        disc(bm, 0, -0.012, post_h, 0.25, 16)
        objs.append(new_obj('sign-ring', m['red'], bm))
        bm = bmesh.new()
        disc(bm, 0, -0.024, post_h, 0.19, 16)
        objs.append(new_obj('sign-inner', m['white'], bm))
    elif kind == 'blue':
        bm = bmesh.new()
        box(bm, 0, 0, post_h - 0.25, 1.30, 0.05, 0.42)
        objs.append(new_obj('sign-board', m['blue'], bm))
        bm = bmesh.new()
        quad(bm, [(-0.60, -0.032, post_h - 0.42), (0.60, -0.032, post_h - 0.42),
                  (0.60, -0.032, post_h - 0.08), (-0.60, -0.032, post_h - 0.08)])
        objs.append(new_obj('sign-border', m['white'], bm))
    elif kind == 'warning':
        bm = bmesh.new()
        s = 0.34
        pts = [(0, -0.03, post_h), (s, -0.03, post_h - s), (0, -0.03, post_h - 2 * s), (-s, -0.03, post_h - s)]
        quad(bm, pts)
        objs.append(new_obj('sign-diamond', m['yellow'], bm))
        bm = bmesh.new()
        s2 = 0.24
        pts = [(0, -0.05, post_h), (s2, -0.05, post_h - s2), (0, -0.05, post_h - 2 * s2), (-s2, -0.05, post_h - s2)]
        quad(bm, pts)
        objs.append(new_obj('sign-diamond-inner', m['dark'], bm))
    else:  # stop
        bm = bmesh.new()
        tri = [(0, -0.03, post_h + 0.42), (0.40, -0.03, post_h - 0.28), (-0.40, -0.03, post_h - 0.28)]
        quad(bm, tri)
        objs.append(new_obj('sign-triangle', m['red'], bm))
    return objs


def build_guardrail(length=2.0):
    """ガードレール 1 段：梁 + 2 根立柱"""
    m = M()
    objs = []
    bm = bmesh.new()
    box(bm, 0, 0, 0.68, length, 0.07, 0.26)          # 波形梁（简化成平板）
    objs.append(new_obj('rail-beam', m['white'], bm))
    bm = bmesh.new()
    for x in (-length / 2 + 0.12, length / 2 - 0.12):
        box(bm, x, 0, 0.34, 0.09, 0.09, 0.70)
    objs.append(new_obj('rail-posts', m['metal'], bm))
    bm = bmesh.new()
    box(bm, 0, -0.045, 0.70, length * 0.92, 0.012, 0.05)   # 反光条
    objs.append(new_obj('rail-reflect', m['yellow'], bm))
    return objs


def build_hydrant():
    """消火栓：高 0.78"""
    m = M()
    objs = []
    bm = bmesh.new()
    cyl(bm, 0, 0, 0, 0.15, 0.13, 0.60, 8)
    cyl(bm, 0, 0, 0.60, 0.13, 0.09, 0.12, 8)
    objs.append(new_obj('hydrant-body', m['red'], bm))
    bm = bmesh.new()
    for s in (-1, 1):
        box(bm, s * 0.16, 0, 0.40, 0.10, 0.10, 0.10)   # 侧出水口
    box(bm, 0, 0, 0.74, 0.09, 0.09, 0.10)              # 顶部阀
    objs.append(new_obj('hydrant-caps', m['metal'], bm))
    return objs


BUILDS = [
    ('prop-pole-a', lambda: build_pole('a')),
    ('prop-pole-b', lambda: build_pole('b')),
    ('prop-wire-span', lambda: build_wire_span()),
    ('prop-vending-drinks', lambda: build_vending('drinks')),
    ('prop-vending-coffee', lambda: build_vending('coffee')),
    ('prop-postbox', build_postbox),
    ('prop-sign-speed', lambda: build_sign('speed')),
    ('prop-sign-blue', lambda: build_sign('blue')),
    ('prop-sign-warning', lambda: build_sign('warning')),
    ('prop-sign-stop', lambda: build_sign('stop')),
    ('prop-guardrail', build_guardrail),
    ('prop-hydrant', build_hydrant),
]

report = []
for name, fn in BUILDS:
    reset()
    objs = fn()
    tris = sum(tri_count(o) for o in objs)
    # 包围盒
    xs, ys, zs = [], [], []
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            xs.append(w.x); ys.append(w.y); zs.append(w.z)
    size = [round(max(xs) - min(xs), 2), round(max(ys) - min(ys), 2), round(max(zs) - min(zs), 2)]
    p = export(objs, name, OUT)
    report.append({'file': name + '.glb', 'triangles': tris, 'bytes': os.path.getsize(p), 'size_m': size})
    flag = '  !! >400 tris' if tris > 400 else ''
    print('EXPORT', name, tris, 'tris', '%.2fx%.2fx%.2f' % tuple(size), flag)

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, 'props-report.json'), 'w', encoding='utf-8') as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print('DONE')
