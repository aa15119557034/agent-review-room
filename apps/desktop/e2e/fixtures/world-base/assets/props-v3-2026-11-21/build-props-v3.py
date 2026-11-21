# build-props-v3.py —— 贩卖机 / 回收箱 / 路牌（带图集贴图）
# 参照 C酱 2026-11-21 反馈：贩卖机正面要有饮料罐、发光展示窗、品牌面板、投币口、取物口；
# 路牌要有真实图案和文字，一张图集铺全部路牌。
import bpy, bmesh, math, os, json
from mathutils import Vector

TEX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'proptex')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'props3')


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat_plain(name, rgb, rough=0.85, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    return m


def mat_tex(name, texfile, emit=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(os.path.join(TEX, texfile), check_existing=True)
    tex.interpolation = 'Linear'
    uv = nt.nodes.new('ShaderNodeUVMap')
    nt.links.new(uv.outputs['UV'], tex.inputs['Vector'])
    nt.links.new(tex.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = 0.55
    if emit > 0:
        nt.links.new(tex.outputs['Color'], b.inputs['Emission Color'])
        b.inputs['Emission Strength'].default_value = emit
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


def cyl(bm, cx, cy, cz, r0, r1, h, seg=10, caps=True):
    res = bmesh.ops.create_cone(bm, cap_ends=caps, segments=seg, radius1=r0, radius2=r1, depth=h)
    for v in res['verts']:
        v.co.x += cx
        v.co.y += cy
        v.co.z += cz + h / 2


def quad_uv(bm, pts, uv, layer):
    vs = [bm.verts.new(p) for p in pts]
    f = bm.faces.new(vs)
    for loop, u in zip(f.loops, uv):
        loop[layer].uv = u
    return f


def cell_uv(cell, inset=0.0):
    """图集 2x2：cell=(col,row) 0/1，返回该格的 (u0,v0,u1,v1)"""
    col, row = cell
    u0 = col * 0.5 + inset
    u1 = (col + 1) * 0.5 - inset
    # 图片第 0 行在 uv 的上半（v 0.5~1.0）
    v0 = 1.0 - (row + 1) * 0.5 + inset
    v1 = 1.0 - row * 0.5 - inset
    return u0, v0, u1, v1


# ---------------------------------------------------------------- 贩卖机
def build_vending(which):
    """which = "drink" | "coffee"；机身和商品窗是两个材质，商品窗可单独加自发光"""
    W, D, H = 1.00, 0.75, 1.83
    row = 0 if which == "drink" else 1
    body_col = (0.70, 0.16, 0.14) if which == "drink" else (0.16, 0.17, 0.19)
    objs = []
    # 机箱
    bm = bmesh.new()
    box(bm, 0, D / 2, H / 2, W, D - 0.02, H)
    objs.append(new_obj("vend-body", mat_plain("vend-body", body_col, 0.55, 0.15), bm, smooth=False))
    # 顶盖
    bm = bmesh.new()
    box(bm, 0, D / 2, H + 0.02, W + 0.04, D + 0.04, 0.04)
    objs.append(new_obj("vend-cap", mat_plain("vend-cap", (0.22, 0.23, 0.25), 0.5, 0.4), bm, smooth=False))
    # 正面机身贴图：取左列对应行
    bm = bmesh.new()
    layer = bm.loops.layers.uv.verify()
    u0, v0, u1, v1 = cell_uv((0, row))
    y = -0.012
    pts = [(-W / 2, y, 0.02), (W / 2, y, 0.02), (W / 2, y, H - 0.02), (-W / 2, y, H - 0.02)]
    quad_uv(bm, pts, [(u0, v0), (u1, v0), (u1, v1), (u0, v1)], layer)
    objs.append(new_obj("vend-face", mat_tex("vend-face", "vending-atlas.png"), bm, smooth=False))
    # 商品窗：单独一片、单独材质（接入时给 vend-window 加自发光）
    bm = bmesh.new()
    layer = bm.loops.layers.uv.verify()
    wu0, wv0, wu1, wv1 = cell_uv((1, row))
    wx = W * 0.41
    wz0, wz1 = H * 0.155, H * 0.645
    yw = -0.016
    pts2 = [(-wx, yw, wz0), (wx, yw, wz0), (wx, yw, wz1), (-wx, yw, wz1)]
    quad_uv(bm, pts2, [(wu0, wv0), (wu1, wv0), (wu1, wv1), (wu0, wv1)], layer)
    objs.append(new_obj("vend-window", mat_tex("vend-window", "vending-atlas.png", emit=0.35), bm, smooth=False))
    # 侧面散热格栅
    bm = bmesh.new()
    for i in range(5):
        box(bm, W / 2 + 0.005, D * 0.55, 0.35 + i * 0.09, 0.01, D * 0.6, 0.03)
    objs.append(new_obj("vend-grille", mat_plain("vend-grille", (0.20, 0.21, 0.23), 0.6, 0.4), bm, smooth=False))
    return objs


def build_recycle_bin():
    """回收箱：0.62 x 0.62 x 0.95，顶部三个投口"""
    objs = []
    bm = bmesh.new()
    box(bm, 0, 0, 0.475, 0.62, 0.62, 0.95)
    objs.append(new_obj('bin-body', mat_plain('bin-body', (0.30, 0.34, 0.38), 0.7, 0.1), bm, smooth=False))
    bm = bmesh.new()
    box(bm, 0, 0, 0.98, 0.66, 0.66, 0.06)
    objs.append(new_obj('bin-lid', mat_plain('bin-lid', (0.22, 0.25, 0.28), 0.6, 0.2), bm, smooth=False))
    bm = bmesh.new()
    for i, dx in enumerate((-0.18, 0.0, 0.18)):
        cyl(bm, dx, 0, 0.95, 0.075, 0.075, 0.10, 8, caps=False)
    objs.append(new_obj('bin-holes', mat_plain('bin-holes', (0.08, 0.09, 0.10), 0.9), bm, smooth=False))
    bm = bmesh.new()
    box(bm, 0, -0.315, 0.42, 0.40, 0.02, 0.22)
    objs.append(new_obj('bin-label', mat_plain('bin-label', (0.62, 0.66, 0.70), 0.85), bm, smooth=False))
    return objs


# ---------------------------------------------------------------- 路牌
def build_sign(kind):
    """kind: 'speed40' | 'blue' | 'warning' | 'stop'；正面用 sign-atlas 的对应格"""
    cfg = {
        'speed40': (0, 0, 2.45, 0.62, 0.62, 'circle'),
        'blue': (1, 0, 2.55, 1.30, 0.42, 'rect'),
        'warning': (0, 1, 2.35, 0.70, 0.70, 'diamond'),
        'stop': (1, 1, 2.30, 0.82, 0.74, 'triangle_down'),
    }[kind]
    col, row, post_h, sw, sh, shape = cfg
    objs = []
    # 立柱
    bm = bmesh.new()
    cyl(bm, 0, 0, 0, 0.045, 0.040, post_h, 6)
    objs.append(new_obj('sign-post', mat_plain('post', (0.32, 0.34, 0.37), 0.55, 0.5), bm))
    # 牌面
    bm = bmesh.new()
    layer = bm.loops.layers.uv.verify()
    u0, v0, u1, v1 = cell_uv((col, row))
    # 牌中心：倒三角时整块牌抬到杆顶以上，杆顶到牌下沿，不挡字
    cz = post_h + (sh * 0.5 + 0.04) if shape in ("triangle", "triangle_down") else post_h
    y = -0.02
    if shape == 'circle':
        seg = 20
        pts = [(math.cos(2 * math.pi * i / seg) * sw / 2, y, cz + math.sin(2 * math.pi * i / seg) * sh / 2) for i in range(seg)]
        uvs = [((math.cos(2 * math.pi * i / seg) * 0.5 + 0.5) * (u1 - u0) + u0,
                (math.sin(2 * math.pi * i / seg) * 0.5 + 0.5) * (v1 - v0) + v0) for i in range(seg)]
        vs = [bm.verts.new(p) for p in pts]
        f = bm.faces.new(vs)
        for loop, uv in zip(f.loops, uvs):
            loop[layer].uv = uv
    elif shape == 'rect':
        # 图集里蓝牌只占格子的中间一条，按实测比例取样，别把整格压进去
        bu0, bu1 = u0 + (u1 - u0) * 0.07, u0 + (u1 - u0) * 0.93
        bv0, bv1 = v0 + (v1 - v0) * 0.35, v0 + (v1 - v0) * 0.65
        pts = [(-sw / 2, y, cz - sh / 2), (sw / 2, y, cz - sh / 2), (sw / 2, y, cz + sh / 2), (-sw / 2, y, cz + sh / 2)]
        quad_uv(bm, pts, [(bu0, bv0), (bu1, bv0), (bu1, bv1), (bu0, bv1)], layer)
    elif shape == 'diamond':
        pts = [(0, y, cz + sh / 2), (sw / 2, y, cz), (0, y, cz - sh / 2), (-sw / 2, y, cz)]
        quad_uv(bm, pts, [(u0 + (u1 - u0) * 0.5, v1), (u1, v0 + (v1 - v0) * 0.5),
                          (u0 + (u1 - u0) * 0.5, v0), (u0, v0 + (v1 - v0) * 0.5)], layer)
    elif shape == "triangle_down":
        # 日本停止牌：倒三角（尖朝下）
        h2 = sh / 2
        pts = [(-sw / 2, y, cz + h2), (sw / 2, y, cz + h2), (0, y, cz - h2)]
        quad_uv(bm, pts, [(u0, v1), (u1, v1), (u0 + (u1 - u0) * 0.5, v0)], layer)
    else:  # triangle
        h2 = sh / 2
        pts = [(0, y, cz + h2), (sw / 2, y, cz - h2), (-sw / 2, y, cz - h2)]
        quad_uv(bm, pts, [(u0 + (u1 - u0) * 0.5, v1), (u1, v0), (u0, v0)], layer)
    objs.append(new_obj('sign-face', mat_tex('sign-face', 'sign-atlas.png'), bm, smooth=False))
    # 背板（挡住从背面看穿的空白）
    # 背板：形状跟牌面一致（不然圆形/菱形/三角牌周围会露灰边）
    bm = bmesh.new()
    by = 0.022
    if shape == "circle":
        seg = 16
        pts = [(math.cos(2 * math.pi * i / seg) * sw * 0.49, by, cz + math.sin(2 * math.pi * i / seg) * sh * 0.49) for i in range(seg)]
        bm.faces.new([bm.verts.new(p) for p in pts])
    elif shape == "rect":
        pts = [(-sw / 2, by, cz - sh / 2), (sw / 2, by, cz - sh / 2), (sw / 2, by, cz + sh / 2), (-sw / 2, by, cz + sh / 2)]
        bm.faces.new([bm.verts.new(p) for p in pts])
    elif shape == "diamond":
        pts = [(0, by, cz + sh / 2), (sw / 2, by, cz), (0, by, cz - sh / 2), (-sw / 2, by, cz)]
        bm.faces.new([bm.verts.new(p) for p in pts])
    elif shape == "triangle_down":
        h2 = sh / 2
        pts = [(-sw / 2, by, cz + h2), (sw / 2, by, cz + h2), (0, by, cz - h2)]
        bm.faces.new([bm.verts.new(p) for p in pts])
    else:
        h2 = sh / 2
        pts = [(0, by, cz + h2), (sw / 2, by, cz - h2), (-sw / 2, by, cz - h2)]
        bm.faces.new([bm.verts.new(p) for p in pts])
    objs.append(new_obj("sign-back", mat_plain("sign-back", (0.55, 0.57, 0.60), 0.8), bm, smooth=False))
    return objs


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
    ('prop-vending-drink', lambda: build_vending('drink')),
    ('prop-vending-coffee', lambda: build_vending('coffee')),
    ('prop-recycle-bin', build_recycle_bin),
    ('prop-sign-40', lambda: build_sign('speed40')),
    ('prop-sign-direction', lambda: build_sign('blue')),
    ('prop-sign-warning2', lambda: build_sign('warning')),
    ('prop-sign-stop2', lambda: build_sign('stop')),
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

with open(os.path.join(OUT, 'props3-report.json'), 'w', encoding='utf-8') as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print('DONE')






