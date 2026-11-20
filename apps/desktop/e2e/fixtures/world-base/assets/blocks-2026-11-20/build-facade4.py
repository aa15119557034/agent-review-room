"""商业街立面模块 —— 4 种组合（C酱 规格：至少 4 种，能横向拼接）

共同约定：
  底部原点在占地中心、地面 0、+Z 朝街（-Z 是临街面）
  开间 4 m、层高 3.2 m，所以任意两款都能横向拼接（宽度都是 4 的倍数）

四款差异：
  01 四层四开间 + 侧挂楼梯间（暖色）
  02 三层五开间 + 角部切掉一块（咬合）
  03 五层四开间 + 顶部退台体块 + 屋顶广告牌
  04 六层六开间 + 双楼梯间 + 阳台成排
"""
import bpy
import bmesh
import os
import json

OUT = r"E:\agent-review-room\.tmp\blender-blocks\out"
ATLAS = r"E:\agent-review-room\.tmp\blender-blocks\facade-atlas.png"

FLOOR = 3.2
BAY = 4.0
D = 10.0
C = 0.125


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat(name, rgb, rough=0.85):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1.0)
    b.inputs["Roughness"].default_value = rough
    return m


def mat_tex(name, rough=0.7):
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
    return m


def box(bm, cx, cy, cz, sx, sy, sz):
    verts = []
    for dz in (-0.5, 0.5):
        for dy in (-0.5, 0.5):
            for dx in (-0.5, 0.5):
                verts.append(bm.verts.new((cx + dx * sx, cy + dy * sy, cz + dz * sz)))
    bm.verts.ensure_lookup_table()
    idx = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return [bm.faces.new((verts[a], verts[b], verts[c], verts[d])) for a, b, c, d in idx]


def new_obj(name, material, bm):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    return ob


def set_grid_uv(ob, cell_row):
    """每个 quad 面铺一整格（cell_row 从图集顶部数 0..7）"""
    me = ob.data
    uv = me.uv_layers.active
    if uv is None:
        uv = me.uv_layers.new(name='UVMap')
    v0 = 1.0 - (cell_row + 1) * C
    v1 = 1.0 - cell_row * C
    for poly in me.polygons:
        corners = [(0.0, v0), (C, v0), (C, v1), (0.0, v1)]
        for k, li in enumerate(poly.loop_indices):
            uv.data[li].uv = corners[k % 4]


def build(floors, bays, variant, warm_core_side=None, notch=False, setback=False, balconies=False):
    reset()
    objs = []
    W = BAY * bays
    H = FLOOR * floors
    PODIUM = FLOOR * 2

    wall = mat('wall', (0.74, 0.70, 0.64))
    podium_mat = mat('podium', (0.52, 0.50, 0.47))
    pil_mat = mat('pilaster', (0.66, 0.62, 0.56))
    trim_mat = mat('trim', (0.80, 0.77, 0.70))
    warm_mat = mat('warm', (0.78, 0.36, 0.26))
    win = mat_tex('win')
    shutter = mat_tex('shutter')
    canopy_tex = mat_tex('canopy')
    ac_tex = mat_tex('ac')

    # 主体
    bm = bmesh.new()
    box(bm, 0, 0, (PODIUM + H) / 2, W, D, H - PODIUM)
    objs.append(new_obj('body', wall, bm))

    # 角部切掉（咬合）：切掉左上角一个体块，用凹进的深色体块补
    if notch:
        bm = bmesh.new()
        box(bm, -W / 2 + BAY / 2, -D / 2 + 1.2, H / 2, BAY, D - 2.4, H)
        objs.append(new_obj('notch-fill', podium_mat, bm))

    # 裙楼
    bm = bmesh.new()
    box(bm, 0, -0.2, PODIUM / 2, W + 0.8, D + 0.4, PODIUM)
    objs.append(new_obj('podium', podium_mat, bm))

    # 壁柱
    bm = bmesh.new()
    for i in range(bays + 1):
        x = -W / 2 + i * BAY
        box(bm, x, -D / 2 - 0.15, H / 2, 0.6, 0.3, H)
    objs.append(new_obj('pilasters', pil_mat, bm))

    # 窗（正背两面）
    bm = bmesh.new()
    for f in range(1, floors):
        for b in range(bays):
            cx = -W / 2 + BAY * (b + 0.5)
            box(bm, cx, -D / 2 - 0.06, f * FLOOR + 1.55, 2.6, 0.12, 2.0)
            box(bm, cx, D / 2 + 0.06, f * FLOOR + 1.55, 2.6, 0.12, 2.0)
    wo = new_obj('windows', win, bm)
    objs.append(wo)

    # 店面
    bm = bmesh.new()
    for b in range(bays):
        cx = -W / 2 + BAY * (b + 0.5)
        if (b + variant) % 2 == 0:
            box(bm, cx, -D / 2 - 0.45, 1.35, 3.0, 0.15, 2.5)
        else:
            box(bm, cx, -D / 2 - 0.45, 1.45, 3.2, 0.12, 2.3)
    so = new_obj('storefront', shutter, bm)
    objs.append(so)

    # 雨棚
    bm = bmesh.new()
    box(bm, 0, -D / 2 - 0.7, FLOOR + 0.15, W - 1.0, 1.4, 0.18)
    co = new_obj('canopy', canopy_tex, bm)
    objs.append(co)
    bm = bmesh.new()
    box(bm, 0, -D / 2 - 1.32, FLOOR, W - 1.0, 0.12, 0.42)
    objs.append(new_obj('canopy-lip', warm_mat, bm))

    # 阳台
    if balconies:
        bm = bmesh.new()
        for f in range(2, floors):
            for b in range(bays):
                cx = -W / 2 + BAY * (b + 0.5)
                box(bm, cx, -D / 2 - 0.75, f * FLOOR + 0.12, 3.0, 1.5, 0.18)
                box(bm, cx, -D / 2 - 1.45, f * FLOOR + 0.6, 3.0, 0.1, 0.85)
        objs.append(new_obj('balconies', trim_mat, bm))

    # 檐口 + 女儿墙
    bm = bmesh.new()
    box(bm, 0, 0, H + 0.18, W + 0.7, D + 0.7, 0.36)
    objs.append(new_obj('cornice', trim_mat, bm))
    bm = bmesh.new()
    box(bm, 0, 0, H + 0.75, W + 0.2, D + 0.2, 0.8)
    objs.append(new_obj('parapet', wall, bm))

    # 顶部退台体块
    if setback:
        bm = bmesh.new()
        box(bm, W * 0.18, 0, H + 1.8, BAY * 2, D * 0.7, 2.0)
        objs.append(new_obj('setback', wall, bm))
        bm = bmesh.new()
        box(bm, W * 0.18, -D * 0.35, H + 1.6, BAY * 2, 0.3, 1.6)
        objs.append(new_obj('setback-win', trim_mat, bm))

    # 屋顶空调
    bm = bmesh.new()
    box(bm, -W * 0.25, 1.5, H + 1.5, 2.6, 1.8, 1.4)
    box(bm, W * 0.30, 2.6, H + 1.3, 2.2, 1.6, 1.1)
    objs.append(new_obj('roof-ac', ac_tex, bm))

    # 楼梯间（暖色咬合体块）：单侧或双侧
    sides = [warm_core_side] if warm_core_side else ([1, -1] if variant == 4 else [])
    for s in sides:
        bm = bmesh.new()
        box(bm, s * (W / 2 + 1.1), 1.0, H * 0.55, 2.2, 4.0, H * 1.1)
        objs.append(new_obj(f'core-{s}', warm_mat, bm))

    # 招牌位
    for i in range(bays):
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

    # UV：窗 0 行、店面 4 行、雨棚 6 行、空调 7 行
    for ob in objs:
        if ob.name == 'windows':
            set_grid_uv(ob, 0)
        elif ob.name == 'storefront':
            set_grid_uv(ob, 4)
        elif ob.name == 'canopy':
            set_grid_uv(ob, 6)
        elif ob.name == 'roof-ac':
            set_grid_uv(ob, 7)

    tri = 0
    for ob in objs:
        ob.data.calc_loop_triangles()
        tri += len(ob.data.loop_triangles)
    return objs, tri, W, D, H


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


VARIANTS = [
    ('street-facade-01', dict(floors=4, bays=4, variant=1, warm_core_side=1)),
    ('street-facade-02', dict(floors=3, bays=5, variant=2, notch=True)),
    ('street-facade-03', dict(floors=5, bays=4, variant=3, setback=True, warm_core_side=-1)),
    ('street-facade-04', dict(floors=6, bays=6, variant=4, balconies=True)),
]

report = []
for name, kw in VARIANTS:
    objs, tri, W, Dd, H = build(**kw)
    p = export(objs, name)
    report.append({'file': name + '.glb', 'triangles': tri, 'bytes': os.path.getsize(p),
                   'size_m': [round(W, 1), round(Dd, 1), round(H, 1)],
                   'floors': kw['floors'], 'bays': kw['bays']})
    print('EXPORT', name, tri, 'tris', f'{W}x{Dd}x{H}')

with open(os.path.join(OUT, 'facade-report.json'), 'w', encoding='utf-8') as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print('DONE')
