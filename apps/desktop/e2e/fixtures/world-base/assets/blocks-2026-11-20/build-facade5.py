"""商业街立面模块 v3 —— 按 C酱 7 条评审逐条改

1. 雨棚：往外下斜 17°、挑出 1.15 m、条纹朝上可见、两端三角侧板
2. 阳台：板厚 0.2 m + 栏杆（竖条薄片）+ 托梁，对准窗
3. 楼梯间：收窄到 1.7 m、赤陶色 0.62/0.38/0.30、两三条竖向小窗
4. 首层层高 4.0 m（住宅层 3.2 m）；招牌位外凸 0.1 m 并加框
5. 竖向招牌位 sign-slot-v-*：二层到四层、垂直立面伸出 0.8 m
6. 卷帘门条纹方向：UV 转 90°（图集里是横条纹）
7. 立面空调外机：每层窗边 1-2 台
"""
import bpy
import bmesh
import os
import math
import json

OUT = r"E:\agent-review-room\.tmp\blender-blocks\out"
ATLAS = r"E:\agent-review-room\.tmp\blender-blocks\facade-atlas.png"

FLOOR = 3.2
GROUND = 4.0          # 首层层高
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


def set_grid_uv(ob, cell_row, rotate90=False):
    me = ob.data
    uv = me.uv_layers.active or me.uv_layers.new(name='UVMap')
    v0 = 1.0 - (cell_row + 1) * C
    v1 = 1.0 - cell_row * C
    for poly in me.polygons:
        if rotate90:
            corners = [(0.0, v0), (0.0, v1), (C, v1), (C, v0)]
        else:
            corners = [(0.0, v0), (C, v0), (C, v1), (0.0, v1)]
        for k, li in enumerate(poly.loop_indices):
            uv.data[li].uv = corners[k % 4]


def build(floors, bays, variant, core_sides=(), notch=False, setback=False, balconies=False):
    reset()
    objs = []
    W = BAY * bays
    PODIUM = GROUND + FLOOR      # 首层 + 二层
    H = GROUND + (floors - 1) * FLOOR

    wall = mat('wall', (0.74, 0.70, 0.64))
    podium_mat = mat('podium', (0.52, 0.50, 0.47))
    pil_mat = mat('pilaster', (0.66, 0.62, 0.56))
    trim_mat = mat('trim', (0.80, 0.77, 0.70))
    terra = mat('terracotta', (0.62, 0.38, 0.30))     # 楼梯间：赤陶
    canopy_mat = mat_tex('canopy')
    win = mat_tex('win')
    shutter = mat_tex('shutter')
    ac_tex = mat_tex('ac')

    # 主体
    bm = bmesh.new()
    box(bm, 0, 0, (PODIUM + H) / 2, W, D, H - PODIUM)
    objs.append(new_obj('body', wall, bm))

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
        box(bm, -W / 2 + i * BAY, -D / 2 - 0.15, H / 2, 0.6, 0.3, H)
    objs.append(new_obj('pilasters', pil_mat, bm))

    # 窗：首层以上每层每开间一格
    def floor_z(f):
        return GROUND + (f - 1) * FLOOR

    bm = bmesh.new()
    for f in range(1, floors):
        zc = floor_z(f) + FLOOR * 0.5
        for b in range(bays):
            cx = -W / 2 + BAY * (b + 0.5)
            box(bm, cx, -D / 2 - 0.06, zc, 2.6, 0.12, 2.0)
            box(bm, cx, D / 2 + 0.06, zc, 2.6, 0.12, 2.0)
    objs.append(new_obj('windows', win, bm))

    # 店面（首层 4.0 m）
    bm = bmesh.new()
    for b in range(bays):
        cx = -W / 2 + BAY * (b + 0.5)
        if (b + variant) % 2 == 0:
            box(bm, cx, -D / 2 - 0.45, 1.6, 3.0, 0.15, 2.9)
        else:
            box(bm, cx, -D / 2 - 0.45, 1.7, 3.2, 0.12, 2.7)
    objs.append(new_obj('storefront', shutter, bm))

    # 雨棚：下斜 17°、挑出 1.15 m、两端三角侧板
    ang = math.radians(-17)
    bm = bmesh.new()
    tip_y = -D / 2 - 1.15
    fs = box(bm, 0, -D / 2 - 0.575, GROUND + 0.02, W - 0.9, 1.15, 0.12)
    # 让整个棚面绕 X 轴下斜：逐顶点改 z
    for v in bm.verts:
        # 以墙侧为轴：y 越靠外越低
        t = (-v.co.y - (D / 2 - 0.575)) / 1.15     # 0=墙侧 1=外沿
        v.co.z -= t * 1.15 * math.tan(-ang)
    co = new_obj('canopy', canopy_mat, bm)
    objs.append(co)
    # 三角侧板
    bm = bmesh.new()
    for s in (-1, 1):
        x = s * (W / 2 - 0.45)
        vs = [bm.verts.new((x, -D / 2, GROUND + 0.02)),
              bm.verts.new((x, -D / 2 - 1.15, GROUND + 0.02 - 1.15 * math.tan(-ang))),
              bm.verts.new((x, -D / 2, GROUND + 0.02 - 1.15 * math.tan(-ang)))]
        bm.faces.new(vs)
    objs.append(new_obj('canopy-side', trim_mat, bm))

    # 招牌位（首层上方，外凸 0.1，带框）
    for i in range(bays):
        cx = -W / 2 + BAY * (i + 0.5)
        z0 = GROUND - 1.35
        for (name, w, h, dz) in (('sign-slot-%d' % i, 3.2, 0.9, 0.0),):
            me = bpy.data.meshes.new(name)
            ob = bpy.data.objects.new(name, me)
            bpy.context.collection.objects.link(ob)
            bm = bmesh.new()
            y0 = -D / 2 - 0.62
            vs = [bm.verts.new((cx - w / 2, y0, z0)), bm.verts.new((cx + w / 2, y0, z0)),
                  bm.verts.new((cx + w / 2, y0, z0 + h)), bm.verts.new((cx - w / 2, y0, z0 + h))]
            bm.faces.new(vs)
            bm.to_mesh(me); bm.free()
            me.materials.append(trim_mat)
            objs.append(ob)
        # 框
        bm = bmesh.new()
        box(bm, cx, -D / 2 - 0.57, z0 + 0.9, 3.5, 0.1, 0.08)
        box(bm, cx, -D / 2 - 0.57, z0, 3.5, 0.1, 0.08)
        box(bm, cx - 1.71, -D / 2 - 0.57, z0 + 0.45, 0.08, 0.1, 1.0)
        box(bm, cx + 1.71, -D / 2 - 0.57, z0 + 0.45, 0.08, 0.1, 1.0)
        objs.append(new_obj('sign-frame-%d' % i, trim_mat, bm))

    # 竖向招牌位 sign-slot-v-*：二层到四层，垂直立面伸出 0.8
    vz0 = GROUND + 0.6
    vz1 = min(GROUND + 3 * FLOOR, H - 0.8)
    vx = -W / 2 + BAY * 0.5
    me = bpy.data.meshes.new('sign-slot-v-0')
    ob = bpy.data.objects.new('sign-slot-v-0', me)
    bpy.context.collection.objects.link(ob)
    bm = bmesh.new()
    y_out = -D / 2 - 0.8
    vs = [bm.verts.new((vx, y_out, vz0)), bm.verts.new((vx, y_out, vz1)),
          bm.verts.new((vx, -D / 2 - 0.2, vz1)), bm.verts.new((vx, -D / 2 - 0.2, vz0))]
    bm.faces.new(vs)
    bm.to_mesh(me); bm.free()
    me.materials.append(terra)
    objs.append(ob)
    bm = bmesh.new()
    box(bm, vx, -D / 2 - 0.5, (vz0 + vz1) / 2, 0.1, 0.8, vz1 - vz0)   # 竖框背板
    objs.append(new_obj('sign-v-frame', terra, bm))

    # 阳台（板厚 0.2 + 栏杆 + 托梁）
    if balconies:
        bm = bmesh.new()
        rail = bmesh.new()
        for f in range(2, floors):
            zc = floor_z(f) + 0.1
            for b in range(bays):
                cx = -W / 2 + BAY * (b + 0.5)
                box(bm, cx, -D / 2 - 0.75, zc, 3.0, 1.5, 0.2)          # 板
                for sx in (-1.4, -0.7, 0, 0.7, 1.4):                    # 托梁
                    box(bm, cx + sx, -D / 2 - 0.5, zc - 0.18, 0.12, 1.2, 0.18)
                box(rail, cx, -D / 2 - 1.45, zc + 0.5, 3.0, 0.06, 0.06)  # 上横杆
                for k in range(7):                                       # 竖条
                    box(rail, cx - 1.2 + k * 0.4, -D / 2 - 1.45, zc + 0.25, 0.05, 0.05, 0.5)
        objs.append(new_obj('balconies', trim_mat, bm))
        objs.append(new_obj('balcony-rails', pil_mat, rail))

    # 檐口 + 女儿墙
    bm = bmesh.new()
    box(bm, 0, 0, H + 0.18, W + 0.7, D + 0.7, 0.36)
    objs.append(new_obj('cornice', trim_mat, bm))
    bm = bmesh.new()
    box(bm, 0, 0, H + 0.75, W + 0.2, D + 0.2, 0.8)
    objs.append(new_obj('parapet', wall, bm))

    if setback:
        bm = bmesh.new()
        box(bm, W * 0.18, 0, H + 1.8, BAY * 2, D * 0.7, 2.0)
        objs.append(new_obj('setback', wall, bm))

    # 屋顶空调
    bm = bmesh.new()
    box(bm, -W * 0.25, 1.5, H + 1.5, 2.6, 1.8, 1.4)
    box(bm, W * 0.30, 2.6, H + 1.3, 2.2, 1.6, 1.1)
    objs.append(new_obj('roof-ac', ac_tex, bm))

    # 窗边空调外机：每层 1–2 台
    bm = bmesh.new()
    for f in range(1, floors):
        zc = floor_z(f) + 0.55
        for b in range(bays):
            if (b + f) % 2 == 0:
                cx = -W / 2 + BAY * (b + 0.5) + 1.35
                box(bm, cx, -D / 2 - 0.35, zc, 0.9, 0.6, 0.7)
    objs.append(new_obj('wall-ac', ac_tex, bm))

    # 楼梯间：收窄 1.7、赤陶、竖向小窗
    for s in core_sides:
        bm = bmesh.new()
        box(bm, s * (W / 2 + 0.85), 1.0, H * 0.55, 1.7, 3.6, H * 1.05)
        objs.append(new_obj('core-%d' % s, terra, bm))
        bm = bmesh.new()
        for k in range(3):
            box(bm, s * (W / 2 + 0.02), 1.0, H * 0.3 + k * 2.6, 0.08, 1.1, 1.1)
        objs.append(new_obj('core-win-%d' % s, trim_mat, bm))

    # UV
    for ob in objs:
        if ob.name == 'windows':
            set_grid_uv(ob, 0)
        elif ob.name == 'storefront':
            set_grid_uv(ob, 4, rotate90=True)      # 修正：横条纹
        elif ob.name == 'canopy':
            set_grid_uv(ob, 6)
        elif ob.name in ('roof-ac', 'wall-ac'):
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
    ('street-facade-01', dict(floors=4, bays=4, variant=1, core_sides=(1,))),
    ('street-facade-02', dict(floors=3, bays=5, variant=2, notch=True)),
    ('street-facade-03', dict(floors=5, bays=4, variant=3, setback=True, core_sides=(-1,))),
    ('street-facade-04', dict(floors=6, bays=6, variant=4, balconies=True, core_sides=(1,))),
]

report = []
for name, kw in VARIANTS:
    objs, tri, W, Dd, H = build(**kw)
    p = export(objs, name)
    report.append({'file': name + '.glb', 'triangles': tri, 'bytes': os.path.getsize(p),
                   'size_m': [round(W, 1), round(Dd, 1), round(H, 1)],
                   'floors': kw['floors'], 'bays': kw['bays']})
    print('EXPORT', name, tri, 'tris', '%.1fx%.1fx%.1f' % (W, Dd, H))

with open(os.path.join(OUT, 'facade-report.json'), 'w', encoding='utf-8') as f:
    json.dump(report, f, ensure_ascii=False, indent=2)
print('DONE')

