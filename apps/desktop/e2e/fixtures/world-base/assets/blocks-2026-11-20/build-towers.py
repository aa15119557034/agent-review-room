"""远景高楼 6 个变体（3 体型 × 2 屋顶），含 C酱 要的三个加强项

体型：
  slim    细高塔 25×25，72 m
  slab    板楼   40×18，38 m
  setback 阶梯退台 30×30，52 m（2 次退台）
屋顶：
  tank    水箱 + 空调外机
  billboard 屋顶广告牌 + 支撑
  antenna 天线桅杆 + 设备箱

三个加强项（每栋都有）：
  1 竖向分段：每 2 开间一根外凸壁柱，切开水平窗带
  2 咬合体块：侧面外挂楼梯/电梯井，高出主体
  3 顶冠：女儿墙 + 屋顶设备，轮廓有高低
  4 暖色点缀：楼梯间赤陶色 + 顶冠暖色带
"""
import bpy
import bmesh
import os
import math
import json

OUT = r"E:\agent-review-room\.tmp\blender-blocks\out"
ATLAS = r"E:\agent-review-room\.tmp\blender-blocks\window-atlas.png"
CELL = 0.25


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat(name, rgb, rough=0.85):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1.0)
    b.inputs["Roughness"].default_value = rough
    return m


def mat_win():
    m = bpy.data.materials.new('win')
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(ATLAS, check_existing=True)
    tex.interpolation = 'Closest'
    uv = nt.nodes.new("ShaderNodeUVMap")
    nt.links.new(uv.outputs["UV"], tex.inputs["Vector"])
    nt.links.new(tex.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.5
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


def new_obj(name, material, bm):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    return ob


def win_uv(ob, span_cells=4, row=0):
    """每个 quad 面平铺 span_cells 格，行 row（0=白天，1=傍晚）"""
    me = ob.data
    uv = me.uv_layers.active or me.uv_layers.new(name='UVMap')
    v0 = 1.0 - (row + 1) * CELL
    v1 = 1.0 - row * CELL
    for poly in me.polygons:
        corners = [(0.0, v0), (span_cells * CELL, v0), (span_cells * CELL, v1), (0.0, v1)]
        for k, li in enumerate(poly.loop_indices):
            uv.data[li].uv = corners[k % 4]


SHAPES = {
    'slim':    dict(W=25.0, D=25.0, H=72.0, tiers=[(1.0, 1.0, 0.68), (0.82, 0.82, 0.20), (0.62, 0.62, 0.12)]),
    'slab':    dict(W=40.0, D=18.0, H=38.0, tiers=[(1.0, 1.0, 1.0)]),
    'setback': dict(W=30.0, D=30.0, H=52.0, tiers=[(1.0, 1.0, 0.60), (0.78, 0.78, 0.25), (0.56, 0.56, 0.15)]),
}


def build(shape, roof):
    reset()
    cfg = SHAPES[shape]
    W, D, H, tiers = cfg['W'], cfg['D'], cfg['H'], cfg['tiers']
    objs = []

    body = mat('body', (0.60, 0.60, 0.62))
    podium_mat = mat('podium', (0.46, 0.45, 0.45))
    pil = mat('pilaster', (0.68, 0.67, 0.66))
    terra = mat('terracotta', (0.62, 0.38, 0.30))
    trim = mat('trim', (0.74, 0.72, 0.68))
    win = mat_win()

    PODIUM = 6.0
    z = 0.0
    top = 0.0
    tier_geo = []
    for (fx, fy, frac) in tiers:
        h = H * frac
        tier_geo.append((z, h, W * fx, D * fy))
        bm = bmesh.new()
        box(bm, 0, 0, z + h / 2, W * fx, D * fy, h)
        objs.append(new_obj('body-%d' % len(tier_geo), body, bm))
        z += h
        top = z

    # 裙楼（外凸 0.4）
    bm = bmesh.new()
    box(bm, 0, 0, PODIUM / 2, W + 0.8, D + 0.8, PODIUM)
    objs.append(new_obj('podium', podium_mat, bm))

    # 竖向壁柱 + 窗带
    pil_bm = bmesh.new()
    win_bm = bmesh.new()
    for (z0, h, w, d) in tier_geo:
        floors = max(1, int(h / 3.6))
        fh = h / floors
        # 四面
        for f in range(floors):
            zc = z0 + f * fh + fh * 0.55
            if z0 + f * fh < PODIUM - 1e-6:
                continue
            for (cx, cy, sx, sy) in ((0, -d / 2 - 0.06, w * 0.92, 0.14), (0, d / 2 + 0.06, w * 0.92, 0.14),
                                     (-w / 2 - 0.06, 0, 0.14, d * 0.92), (w / 2 + 0.06, 0, 0.14, d * 0.92)):
                box(win_bm, cx, cy, zc, sx, sy, fh * 0.55)
        # 壁柱：每 2 开间
        bays = max(2, int(round(w / 8.0)))
        for i in range(bays + 1):
            x = -w / 2 + i * (w / bays)
            box(pil_bm, x, -d / 2 - 0.18, z0 + h / 2, 0.7, 0.36, h)
            box(pil_bm, x, d / 2 + 0.18, z0 + h / 2, 0.7, 0.36, h)
        for i in range(bays + 1):
            y = -d / 2 + i * (d / bays)
            box(pil_bm, -w / 2 - 0.18, y, z0 + h / 2, 0.36, 0.7, h)
            box(pil_bm, w / 2 + 0.18, y, z0 + h / 2, 0.36, 0.7, h)
    w_ob = new_obj('windows', win, win_bm)
    win_uv(w_ob, span_cells=4, row=0)
    objs.append(w_ob)
    objs.append(new_obj('pilasters', pil, pil_bm))

    # 女儿墙 + 檐口
    bm = bmesh.new()
    tw, td = tier_geo[-1][2], tier_geo[-1][3]
    box(bm, 0, 0, top + 0.3, tw + 0.5, td + 0.5, 0.6)
    objs.append(new_obj('parapet', trim, bm))
    # 暖色带（顶冠点缀）
    bm = bmesh.new()
    box(bm, 0, 0, top - 0.9, tw + 0.62, td + 0.62, 0.7)
    objs.append(new_obj('crown-band', terra, bm))

    # 咬合体块：侧面楼梯井，高出主体
    bm = bmesh.new()
    core_h = 6.0 if shape == 'slab' else 8.0   # 板楼总高要压回 45 m 以内
    box(bm, tw / 2 + 1.6, 0, (top + core_h) / 2, 3.2, 4.2, top + core_h)
    objs.append(new_obj('core', terra, bm))

    # 屋顶细节
    bm = bmesh.new()
    if roof == 'tank':
        box(bm, 0, 0, top + 3.0, 7, 7, 5.0)
        for sx in (-2.8, 2.8):
            for sy in (-2.8, 2.8):
                box(bm, sx, sy, top + 1.1, 0.6, 0.6, 2.2)
    elif roof == 'billboard':
        box(bm, 0, 0, top + 3.4, tw * 0.7, 0.5, 2.6)
        for sx in (-tw * 0.3, tw * 0.3):
            box(bm, sx, 0, top + 1.6, 0.6, 0.6, 3.2)
    else:  # antenna
        box(bm, 0, 0, top + 6.0, 0.5, 0.5, 12.0)
        box(bm, 0, 0, top + 1.2, 4, 4, 2.4)
        box(bm, 0, 0, top + 9.5, 3.2, 0.25, 0.25)
    for i in range(3):
        box(bm, -tw * 0.3 + i * tw * 0.28, td * 0.25, top + 0.9, 2.4, 1.8, 1.4)
    objs.append(new_obj('roof-detail', trim, bm))

    tri = 0
    for ob in objs:
        ob.data.calc_loop_triangles()
        tri += len(ob.data.loop_triangles)
    return objs, tri, W, D, top + core_h


def export(objs, name):
    os.makedirs(OUT, exist_ok=True)
    for ob in bpy.context.scene.objects:
        ob.select_set(False)
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    path = os.path.join(OUT, name + '.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
                              export_apply=True, export_yup=True)
    return path


report = []
for shape in ('slim', 'slab', 'setback'):
    for roof in ('tank', 'billboard'):
        name = 'skyline-tower-%s-%s' % (shape, roof)
        objs, tri, W, D, H = build(shape, roof)
        p = export(objs, name)
        report.append({'file': name + '.glb', 'triangles': tri, 'bytes': os.path.getsize(p),
                       'size_m': [round(W, 1), round(D, 1), round(H, 1)]})
        flag = '  ⚠️ 超 3k' if tri > 3000 else ''
        print('EXPORT', name, tri, 'tris', '%.0fx%.0fx%.0f' % (W, D, H), flag)

with open(os.path.join(OUT, 'tower-report.json'), 'w', encoding='utf-8') as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print('DONE')

