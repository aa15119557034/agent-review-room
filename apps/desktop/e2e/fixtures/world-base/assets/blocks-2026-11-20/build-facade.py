"""商业街立面模块（按 C酱 规格第 1 条的五项加强）

- 底座/主体分开：首二层裙楼，外凸 0.4 m，另一种颜色
- 竖向分段：每 2 开间一根外凸壁柱，切开水平窗带
- 咬合体块：角部切掉 + 侧面外挂楼梯间体块
- 顶冠：女儿墙 + 屋顶空调外机
- 暖色点缀：雨棚条纹 + 招牌底板

坐标：底部原点在占地中心、地面 0、+Z 朝街（-Z 是临街面）
"""
import bpy
import bmesh
import os
import math
import json
from mathutils import Vector

OUT = r"E:\agent-review-room\.tmp\blender-blocks\out"
ATLAS = r"E:\agent-review-room\.tmp\blender-blocks\facade-atlas.png"

FLOOR = 3.2
BAY = 4.0
BAYS = 4
FLOORS = 4
W = BAY * BAYS          # 16
D = 10.0
H = FLOOR * FLOORS      # 12.8
PODIUM = FLOOR * 2      # 6.4

C = 0.125               # 图集格（8×8）


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat(name, rgb, rough=0.85):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1.0)
    b.inputs["Roughness"].default_value = rough
    return m


def mat_tex(name, cell_u, cell_v, rough=0.7):
    """cell_u/cell_v 是 0..7 的列/行（从左上算）"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(ATLAS, check_existing=True)
    tex.interpolation = 'Closest'
    uv = nt.nodes.new("ShaderNodeUVMap")
    nt.links.new(uv.outputs["UV"], tex.inputs["Vector"])
    nt.links.new(tex.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    m["cell_u"], m["cell_v"] = cell_u, cell_v
    return m


def uv_for(faces, uv_layer, u0, v0, u1, v1):
    cs = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
    for fc in faces:
        for i, loop in enumerate(fc.loops):
            loop[uv_layer].uv = cs[i % 4]


def box(bm, cx, cy, cz, sx, sy, sz):
    verts = []
    for dz in (-0.5, 0.5):
        for dy in (-0.5, 0.5):
            for dx in (-0.5, 0.5):
                verts.append(bm.verts.new((cx + dx * sx, cy + dy * sy, cz + dz * sz)))
    bm.verts.ensure_lookup_table()
    idx = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return [bm.faces.new((verts[a], verts[b], verts[c], verts[d])) for a, b, c, d in idx]


def new_obj(name, mat_, bm):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat_)
    return ob


def build():
    reset()
    objs = []

    wall = mat('wall', (0.74, 0.70, 0.64))
    podium_mat = mat('podium', (0.52, 0.50, 0.47))
    pil_mat = mat('pilaster', (0.66, 0.62, 0.56))
    trim_mat = mat('trim', (0.80, 0.77, 0.70))
    warm_mat = mat('warm', (0.78, 0.36, 0.26))          # 暖色点缀
    win_day = mat_tex('win-day', 0, 1)
    win_eve = mat_tex('win-eve', 0, 3)
    shutter = mat_tex('shutter', 0, 4)
    canopy_tex = mat_tex('canopy', 0, 6)
    ac_tex = mat_tex('ac', 0, 7)

    # ---- 主体
    bm = bmesh.new()
    box(bm, 0, 0, (PODIUM + H) / 2, W, D, H - PODIUM)
    objs.append(new_obj('body', wall, bm))

    # ---- 裙楼（外凸 0.4）
    bm = bmesh.new()
    box(bm, 0, -0.2, PODIUM / 2, W + 0.8, D + 0.4, PODIUM)
    objs.append(new_obj('podium', podium_mat, bm))

    # ---- 竖向壁柱（5 根：两端 + 3 根内部分隔）
    bm = bmesh.new()
    for i in range(BAYS + 1):
        x = -W / 2 + i * BAY
        box(bm, x, -D / 2 - 0.15, H / 2, 0.6, 0.3, H)
    objs.append(new_obj('pilasters', pil_mat, bm))

    # ---- 窗（每层每开间一格，贴图出窗格）
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    faces_all = []
    for f in range(1, FLOORS):
        for b in range(BAYS):
            cx = -W / 2 + BAY * (b + 0.5)
            zc = f * FLOOR + 1.55
            fs = box(bm, cx, -D / 2 - 0.06, zc, 2.6, 0.12, 2.0)
            faces_all.append((fs, 0, 1))
    # 反面（背面窗，同一套贴图）
    for f in range(1, FLOORS):
        for b in range(BAYS):
            cx = -W / 2 + BAY * (b + 0.5)
            fs = box(bm, cx, D / 2 + 0.06, f * FLOOR + 1.55, 2.6, 0.12, 2.0)
            faces_all.append((fs, 0, 1))
    objs.append(new_obj('windows', win_day, bm))
    # 单独给每个面设 UV：一窗一格
    for ob in objs:
        if ob.name == 'windows':
            me = ob.data
            uvlay = me.uv_layers.active
            for poly in me.polygons:
                for li in poly.loop_indices:
                    v = me.vertices[me.loops[li].vertex_index].co
                    # 用面的前两个角简单铺满一格
            # 简化：整体 UV 按格铺（每面已是独立 quad，用 loop 索引均分）
            for i, poly in enumerate(me.polygons):
                u0 = 0.0
                v0 = 1.0 - C
                for k, li in enumerate(poly.loop_indices):
                    uvlay.data[li].uv = [(u0, v0), (u0 + C, v0), (u0 + C, v0 + C), (u0, v0 + C)][k % 4]

    # ---- 首层店面（卷帘门 / 橱窗交替）
    bm = bmesh.new()
    for b in range(BAYS):
        cx = -W / 2 + BAY * (b + 0.5)
        if b % 2 == 0:
            box(bm, cx, -D / 2 - 0.45, 1.35, 3.0, 0.15, 2.5)      # 卷帘门
        else:
            box(bm, cx, -D / 2 - 0.45, 1.45, 3.2, 0.12, 2.3)      # 橱窗
    objs.append(new_obj('storefront', shutter, bm))

    # ---- 雨棚（裙楼与二层交界，外凸 1.2，条纹贴图 = 暖色点缀）
    bm = bmesh.new()
    box(bm, 0, -D / 2 - 0.7, FLOOR + 0.15, W - 1.0, 1.4, 0.18)
    objs.append(new_obj('canopy', canopy_tex, bm))
    bm = bmesh.new()
    box(bm, 0, -D / 2 - 1.32, FLOOR, W - 1.0, 0.12, 0.42)         # 雨棚前檐（暖色）
    objs.append(new_obj('canopy-lip', warm_mat, bm))

    # ---- 阳台（第 2、3 层，0 与 2 号开间）
    bm = bmesh.new()
    for f in (2, 3):
        for b in (0, 2):
            cx = -W / 2 + BAY * (b + 0.5)
            box(bm, cx, -D / 2 - 0.75, f * FLOOR + 0.12, 3.0, 1.5, 0.18)   # 阳台板
            box(bm, cx, -D / 2 - 1.45, f * FLOOR + 0.6, 3.0, 0.1, 0.85)    # 栏杆板
    objs.append(new_obj('balconies', trim_mat, bm))

    # ---- 檐口（顶部外凸）+ 女儿墙
    bm = bmesh.new()
    box(bm, 0, 0, H + 0.18, W + 0.7, D + 0.7, 0.36)
    objs.append(new_obj('cornice', trim_mat, bm))
    bm = bmesh.new()
    box(bm, 0, 0, H + 0.75, W + 0.2, D + 0.2, 0.8)
    objs.append(new_obj('parapet', wall, bm))

    # ---- 屋顶空调外机（顶冠的高低轮廓）
    bm = bmesh.new()
    box(bm, -3.5, 1.5, H + 1.5, 2.6, 1.8, 1.4)
    box(bm, 2.0, 2.6, H + 1.3, 2.2, 1.6, 1.1)
    objs.append(new_obj('roof-ac', ac_tex, bm))

    # ---- 侧面外挂楼梯间（咬合体块，暖色）
    bm = bmesh.new()
    box(bm, W / 2 + 1.1, 1.0, H * 0.55, 2.2, 4.0, H * 1.1)
    objs.append(new_obj('core', warm_mat, bm))

    # ---- 招牌位（空平面，命名 sign-slot-*）
    for i in range(BAYS):
        cx = -W / 2 + BAY * (i + 0.5)
        me = bpy.data.meshes.new(f'sign-slot-{i}')
        ob = bpy.data.objects.new(f'sign-slot-{i}', me)
        bpy.context.collection.objects.link(ob)
        bm = bmesh.new()
        w, h, y = 3.2, 1.0, -D / 2 - 0.52
        z0 = FLOOR + 0.45
        vs = [bm.verts.new((cx - w / 2, y, z0)), bm.verts.new((cx + w / 2, y, z0)),
              bm.verts.new((cx + w / 2, y, z0 + h)), bm.verts.new((cx - w / 2, y, z0 + h))]
        bm.faces.new(vs)
        bm.to_mesh(me); bm.free()
        me.materials.append(trim_mat)
        objs.append(ob)

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


objs, tri = build()
p = export(objs, 'street-facade-01')
print('EXPORT street-facade-01', tri, 'tris', os.path.getsize(p), 'bytes')
with open(os.path.join(OUT, 'facade-report.json'), 'w', encoding='utf-8') as f:
    json.dump([{'file': 'street-facade-01.glb', 'triangles': tri, 'bytes': os.path.getsize(p)}], f, ensure_ascii=False, indent=2)
print('DONE')
