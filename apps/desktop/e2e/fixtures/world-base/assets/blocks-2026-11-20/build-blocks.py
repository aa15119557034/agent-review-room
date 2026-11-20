"""X-51 远景高楼 + 商业街立面：Blender 程序化建模 → GLB

不用任何第三方插件（Building Tools / Buildify 等许可未确认，这里全部用 bpy/bmesh 手写）。
坐标约定（C酱 规格）：
  - 底部原点在占地中心、地面高 0
  - +Z 朝前（朝街）
  - 窗用共用 512² 图集 UV 平铺，不逐窗建模
  - 屋顶细节单独子网格，命名 roof-detail，方便远处 LOD 去掉
"""
import bpy
import bmesh
import math
import os
import sys
from mathutils import Vector

OUT = r"E:\agent-review-room\.tmp\blender-blocks\out"
ATLAS = r"E:\agent-review-room\.tmp\blender-blocks\window-atlas.png"

# 图集：4×4 格。白天用第 0 行，傍晚用第 2 行；每格 UV 范围
CELL = 0.25
DAY_V = (1.0 - 2 * CELL, 1.0 - CELL)      # 第 0 行（v 从下往上算，Blender UV 原点左下）
DAY_U = (0.0, CELL)
EVE_V = (1.0 - 4 * CELL, 1.0 - 3 * CELL)  # 第 2 行


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat_color(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Metallic"].default_value = 0.0
    return m


def mat_window(name, evening=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(ATLAS, check_existing=True)
    tex.interpolation = 'Closest'
    uv = nt.nodes.new("ShaderNodeUVMap")
    nt.links.new(uv.outputs["UV"], tex.inputs["Vector"])
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.55
    return m


def box(bm, cx, cy, cz, sx, sy, sz):
    """中心 (cx,cy,cz)，尺寸 sx,sy,sz 的盒子，返回新增面"""
    verts = []
    for dz in (-0.5, 0.5):
        for dy in (-0.5, 0.5):
            for dx in (-0.5, 0.5):
                verts.append(bm.verts.new((cx + dx * sx, cy + dy * sy, cz + dz * sz)))
    bm.verts.ensure_lookup_table()
    idx = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    faces = []
    for a, b, c, d in idx:
        faces.append(bm.faces.new((verts[a], verts[b], verts[c], verts[d])))
    return faces


def build_tower(kind, roof, evening=False):
    """返回 (对象列表, 三角面数)"""
    reset()
    objs = []

    if kind == 'slim':
        W, D, H = 25.0, 25.0, 70.0
        tiers = [(1.0, 1.0, H)]
    elif kind == 'slab':
        W, D, H = 40.0, 18.0, 38.0
        tiers = [(1.0, 1.0, H)]
    else:  # setback
        W, D, H = 30.0, 30.0, 52.0
        tiers = [(1.0, 1.0, H * 0.62), (0.78, 0.78, H * 0.26), (0.56, 0.56, H * 0.12)]

    # ---- 楼体分层：基座 / 主体 / 顶冠（三种色，打破单一白盒）
    z = 0.0
    body_mat = mat_color('tower-body', (0.70, 0.66, 0.60))
    base_mat = mat_color('tower-base', (0.44, 0.42, 0.40))
    crown_mat = mat_color('tower-crown', (0.56, 0.53, 0.48))
    win_mat = mat_window('tower-win', evening)
    for k, (fx, fy, h) in enumerate(tiers):
        me = bpy.data.meshes.new(f'body{k}')
        ob = bpy.data.objects.new(f'body{k}', me)
        bpy.context.collection.objects.link(ob)
        bm = bmesh.new()
        box(bm, 0, 0, z + h / 2, W * fx, D * fy, h)
        bm.to_mesh(me)
        bm.free()
        me.materials.append(base_mat if k == 0 else body_mat)
        objs.append(ob)
        z += h
        # 基座腰线：贴着第一段底部加一圈深色带
        if k == 0:
            me2 = bpy.data.meshes.new('baseband')
            ob2 = bpy.data.objects.new('baseband', me2)
            bpy.context.collection.objects.link(ob2)
            bm2 = bmesh.new()
            box(bm2, 0, 0, 2.6, W * fx + 0.5, D * fy + 0.5, 5.2)
            bm2.to_mesh(me2); bm2.free()
            me2.materials.append(base_mat)
            objs.append(ob2)

    # ---- 窗带（每层一圈细盒，UV 平铺；不逐窗建模）
    floors = max(3, int(z / 3.2))
    win_ob = None
    me = bpy.data.meshes.new('windows')
    win_ob = bpy.data.objects.new('windows', me)
    bpy.context.collection.objects.link(win_ob)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new('UVMap')
    for f in range(1, floors):
        y = f * (z / floors)
        # 四面各一条窗带
        for (nx, ny, sx, sy) in ((0, 1, W * 0.98, 0.3), (0, -1, W * 0.98, 0.3), (1, 0, 0.3, D * 0.98), (-1, 0, 0.3, D * 0.98)):
            cx = nx * (W / 2 if nx else 0)
            cy = ny * (D / 2 if ny else 0)
            faces = box(bm, cx, cy, y + 1.4, sx, sy, 2.2)
            v0, v1 = (DAY_V if not evening else EVE_V)
            for fc in faces:
                # 按面的实际宽度决定平铺几格（每 4 m 一格），高始终 1 格
                span = max(1, int(round(max(sx, sy) / 4.0)))
                cs = [(0.0, v0), (span * CELL, v0), (span * CELL, v1), (0.0, v1)]
                for i, loop in enumerate(fc.loops):
                    loop[uv_layer].uv = cs[i % 4]
    bm.to_mesh(me)
    bm.free()
    me.materials.append(win_mat)
    objs.append(win_ob)

    # ---- 屋顶细节（单独子网格 roof-detail）
    me = bpy.data.meshes.new('roof-detail')
    roof_ob = bpy.data.objects.new('roof-detail', me)
    bpy.context.collection.objects.link(roof_ob)
    bm = bmesh.new()
    detail_mat = mat_color('roof-detail', (0.52, 0.52, 0.55))
    if roof == 'tank':
        # 水箱 + 支腿
        box(bm, 0, 0, z + 2.4, 6, 6, 4.8)
        for sx in (-2.4, 2.4):
            for sy in (-2.4, 2.4):
                box(bm, sx, sy, z + 0.9, 0.5, 0.5, 1.8)
    else:  # billboard
        box(bm, 0, 0, z + 1.2, 14, 0.4, 2.4)          # 屋顶广告牌
        for sx in (-5.5, 5.5):
            box(bm, sx, 0, z + 0.6, 0.6, 0.6, 1.2)
    # 空调外机几台
    for i in range(3):
        box(bm, -8 + i * 7, -4, z + 0.6, 2.2, 1.6, 1.2)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(detail_mat)
    objs.append(roof_ob)

    # 合并成一个 GLB 风格的对象组：保留 roof-detail 独立
    tri = 0
    for ob in objs:
        ob.data.calc_loop_triangles()
        tri += len(ob.data.loop_triangles)
    return objs, tri


def build_facade(idx, evening=False):
    reset()
    objs = []
    FLOOR = 3.2
    BAY = 4.0
    BAYS = 4
    FLOORS = 4
    W = BAY * BAYS
    D = 10.0
    H = FLOOR * FLOORS

    body = mat_color('facade-body', (0.70, 0.66, 0.60))
    win = mat_window('facade-win', evening)

    me = bpy.data.meshes.new('facade-body')
    ob = bpy.data.objects.new('facade-body', me)
    bpy.context.collection.objects.link(ob)
    bm = bmesh.new()
    box(bm, 0, 0, H / 2, W, D, H)
    bm.to_mesh(me); bm.free()
    me.materials.append(body)
    objs.append(ob)

    # 上层窗（每层每开间一个窗盒）
    me = bpy.data.meshes.new('facade-windows')
    wo = bpy.data.objects.new('facade-windows', me)
    bpy.context.collection.objects.link(wo)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new('UVMap')
    for f in range(1, FLOORS):
        for b in range(BAYS):
            cx = -W / 2 + BAY * (b + 0.5)
            cy = -D / 2 - 0.15
            faces = box(bm, cx, cy, f * FLOOR + 1.6, 2.2, 0.3, 1.6)
            v0, v1 = (DAY_V if not evening else EVE_V)
            for fc in faces:
                cs = [(0.0, v0), (CELL, v0), (CELL, v1), (0.0, v1)]
                for i, loop in enumerate(fc.loops):
                    loop[uv_layer].uv = cs[i % 4]
    bm.to_mesh(me); bm.free()
    me.materials.append(win)
    objs.append(wo)

    # 首层店面：卷帘门 or 橱窗
    me = bpy.data.meshes.new('storefront')
    so = bpy.data.objects.new('storefront', me)
    bpy.context.collection.objects.link(so)
    bm = bmesh.new()
    shop_mat = mat_color('storefront', (0.34, 0.36, 0.40))
    for b in range(BAYS):
        cx = -W / 2 + BAY * (b + 0.5)
        if b % 2 == 0:
            box(bm, cx, -D / 2 - 0.12, 1.4, 3.2, 0.25, 2.6)      # 卷帘门
        else:
            box(bm, cx, -D / 2 - 0.12, 1.5, 3.4, 0.2, 2.2)       # 橱窗
    bm.to_mesh(me); bm.free()
    me.materials.append(shop_mat)
    objs.append(so)

    # 招牌位：空平面，命名 sign-slot-*
    for i, b in enumerate(range(BAYS)):
        cx = -W / 2 + BAY * (b + 0.5)
        me = bpy.data.meshes.new(f'sign-slot-{i}')
        so2 = bpy.data.objects.new(f'sign-slot-{i}', me)
        bpy.context.collection.objects.link(so2)
        bm = bmesh.new()
        w, h = 3.4, 1.1
        vs = [bm.verts.new((cx - w / 2, -D / 2 - 0.02, FLOOR * 1.05 - h / 2)),
              bm.verts.new((cx + w / 2, -D / 2 - 0.02, FLOOR * 1.05 - h / 2)),
              bm.verts.new((cx + w / 2, -D / 2 - 0.02, FLOOR * 1.05 + h / 2)),
              bm.verts.new((cx - w / 2, -D / 2 - 0.02, FLOOR * 1.05 + h / 2))]
        bm.faces.new(vs)
        bm.to_mesh(me); bm.free()
        me.materials.append(mat_color('sign-slot', (0.9, 0.9, 0.9)))
        objs.append(so2)

    tri = 0
    for ob in objs:
        ob.data.calc_loop_triangles()
        tri += len(ob.data.loop_triangles)
    return objs, tri


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


def main():
    report = []
    jobs = [
        (['slim', 'tank'], 'skyline-tower-slim-tank'),
        (['slab', 'billboard'], 'skyline-tower-slab-billboard'),
    ]
    for (args, name) in jobs:
        objs, tri = build_tower(args[0], args[1])
        p = export(objs, name)
        report.append({'file': os.path.basename(p), 'triangles': tri, 'bytes': os.path.getsize(p)})
        print('EXPORT', name, tri, 'tris')

    objs, tri = build_facade(0)
    p = export(objs, 'street-facade-01')
    report.append({'file': os.path.basename(p), 'triangles': tri, 'bytes': os.path.getsize(p)})
    print('EXPORT street-facade-01', tri, 'tris')

    import json
    with open(os.path.join(OUT, 'report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print('DONE')


main()


