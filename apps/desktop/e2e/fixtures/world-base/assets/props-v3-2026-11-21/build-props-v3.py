# build-props-v3.py —— 贩卖机 / 回收箱 / 路牌（带图集贴图）
# 参照 C酱 2026-11-21 反馈：贩卖机正面要有饮料罐、发光展示窗、品牌面板、投币口、取物口；
# 路牌要有真实图案和文字，一张图集铺全部路牌。
import argparse
import sys
import bpy, bmesh, math, os, json
from mathutils import Vector

TEX = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(TEX, 'out', 'props3')


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
    # The window's inset must match vend_body_cell's opening, including the
    # face's 2 cm end clearance and the image-space Y direction.
    wx = W * 0.43
    wz0, wz1 = 0.02 + (H - 0.04) * 0.34, 0.02 + (H - 0.04) * 0.87
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
    """回收箱正面有两个圆形投口，盖板后有可见的收料腔。"""
    objs = []
    bm = bmesh.new()
    box(bm, 0, 0, 0.33, 0.62, 0.62, 0.66)
    for x in (-0.29, 0.29):
        box(bm, x, 0, 0.81, 0.04, 0.62, 0.30)
    box(bm, 0, 0.29, 0.81, 0.54, 0.04, 0.30)
    objs.append(new_obj('bin-body', mat_plain('bin-body', (0.77, 0.81, 0.74), 0.7, 0.1), bm, smooth=False))
    bm = bmesh.new()
    box(bm, 0, 0, 0.99, 0.66, 0.66, 0.06)
    objs.append(new_obj('bin-lid', mat_plain('bin-lid', (0.14, 0.36, 0.29), 0.6, 0.2), bm, smooth=False))

    panel, rims, wells = bmesh.new(), bmesh.new(), bmesh.new()
    for center in (-0.155, 0.155):
        outer = []
        edge = []
        rim = []
        opening = []
        throat = []
        for i in range(16):
            angle = i * math.tau / 16
            dx, dz = math.cos(angle), math.sin(angle)
            rectangle = max(abs(dx), abs(dz))
            outer.append(panel.verts.new((center + 0.155 * dx / rectangle, -0.31, 0.81 + 0.15 * dz / rectangle)))
            edge.append(panel.verts.new((center + 0.116 * dx, -0.31, 0.81 + 0.116 * dz)))
            rim.append(rims.verts.new((center + 0.116 * dx, -0.311, 0.81 + 0.116 * dz)))
            opening.append(rims.verts.new((center + 0.091 * dx, -0.326, 0.81 + 0.091 * dz)))
            throat.append(wells.verts.new((center + 0.091 * dx, -0.326, 0.81 + 0.091 * dz)))
        interior = [wells.verts.new((v.co.x, -0.17, v.co.z)) for v in throat]
        for i in range(16):
            j = (i + 1) % 16
            panel.faces.new((outer[i], outer[j], edge[j], edge[i]))
            rims.faces.new((rim[i], rim[j], opening[j], opening[i]))
            wells.faces.new((throat[j], throat[i], interior[i], interior[j]))
        wells.faces.new(interior)
    objs.append(new_obj('bin-panel', mat_plain('bin-panel', (0.77, 0.81, 0.74)), panel, smooth=False))
    objs.append(new_obj('bin-rims', mat_plain('bin-rims', (0.34, 0.53, 0.46)), rims, smooth=False))
    objs.append(new_obj('bin-wells', mat_plain('bin-wells', (0.018, 0.035, 0.043)), wells, smooth=False))

    bm = bmesh.new()
    uv = bm.loops.layers.uv.verify()
    quad_uv(bm, [(-0.246, -0.312, 0.39), (0.246, -0.312, 0.39),
                 (0.246, -0.312, 0.565), (-0.246, -0.312, 0.565)],
            [(0, 0), (1, 0), (1, 1), (0, 1)], uv)
    objs.append(new_obj('bin-label', mat_tex('bin-label', 'recycle-label.png'), bm, smooth=False))
    # Match the existing station bin footprint and collision height.
    for ob in objs:
        ob.scale = (0.44 / 0.66, 0.36 / 0.66, 0.87 / 1.02)
    return objs


# ---------------------------------------------------------------- 路牌
def build_sign(kind):
    """kind: 'speed40' | 'blue' | 'warning' | 'stop'；正面用 sign-atlas 的对应格"""
    cfg = {
        'speed40': (0, 0, 2.45, 0.62, 0.62, 'circle'),
        'blue': (1, 0, 2.55, 1.30, 0.42, 'rect'),
        'warning': (0, 1, 2.35, 0.70, 0.70, 'diamond'),
        'stop': (1, 1, 2.20, 0.80, 0.70, 'triangle_down'),
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
    # The stop sign sits on the original 2.62 m silhouette, with the pole behind its face.
    cz = post_h + 0.07 if shape == 'triangle_down' else post_h
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
        # Match the printed triangle in make-prop-atlas.py, including its white rim.
        # Mapping the whole cell clipped 「れ」 against the physical diagonal.
        h2 = sh / 2
        pts = [(-sw / 2, y, cz + h2), (0, y, cz - h2), (sw / 2, y, cz + h2)]
        du, dv = u1 - u0, v1 - v0
        top = v1 - dv * (0.5 - 0.44 * 0.80)
        bottom = v1 - dv * (0.5 + 0.44 * 0.86)
        quad_uv(bm, pts, [(u0 + du * 0.06, top), (u0 + du * 0.5, bottom),
                          (u1 - du * 0.06, top)], layer)
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
    ('prop-vending-drinks', lambda: build_vending('drink')),
    ('prop-vending-coffee', lambda: build_vending('coffee')),
    ('prop-recycle-bin', build_recycle_bin),
    ('prop-sign-40', lambda: build_sign('speed40')),
    ('prop-sign-direction', lambda: build_sign('blue')),
    ('prop-sign-warning2', lambda: build_sign('warning')),
    ('prop-sign-stop', lambda: build_sign('stop')),
]

parser = argparse.ArgumentParser()
parser.add_argument('--output', default=OUT)
parser.add_argument('--only', nargs='+', choices=[name for name, _ in BUILDS])
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
OUT = args.output
report = []
for name, fn in BUILDS:
    if args.only and name not in args.only:
        continue
    reset()
    objs = fn()
    bpy.context.view_layer.update()
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






