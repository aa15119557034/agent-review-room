# build-tree-v2.py —— 重构版阔叶树（C酱/江浩 2026-11-21 反馈：要参考图的质感）
# 要点：平滑法线、顶点色明暗（下暗冷/上亮暖/边缘暖光）、轮廓挂 alpha 叶片卡、树干收分带主枝
import bpy, bmesh, math, os, json, random
from mathutils import Vector, Matrix

TEX = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'vegtex')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'trees')


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mk_mat_solid(name, rgb, rough=0.9):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    b.inputs['Roughness'].default_value = rough
    return m


def mk_mat_vcol(name, rough=0.85):
    """用顶点色驱动 Base Color"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    attr = nt.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Col'
    nt.links.new(attr.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = rough
    return m


def mk_mat_card(name, texfile):
    """alpha 裁切贴图卡"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(os.path.join(TEX, texfile), check_existing=True)
    tex.interpolation = 'Linear'
    uv = nt.nodes.new('ShaderNodeUVMap')
    nt.links.new(uv.outputs['UV'], tex.inputs['Vector'])
    mix = nt.nodes.new('ShaderNodeMixRGB')
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Fac'].default_value = 1.0
    mix.inputs['Color2'].default_value = (1.25, 1.30, 1.05, 1.0)
    nt.links.new(tex.outputs['Color'], mix.inputs['Color1'])
    nt.links.new(mix.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(tex.outputs['Alpha'], b.inputs['Alpha'])
    b.inputs['Roughness'].default_value = 0.85
    try:
        m.surface_render_method = 'DITHERED'   # Blender 4.2+：DITHERED → glTF MASK
    except Exception:
        pass
    try:
        m.blend_method = 'CLIP'                 # 旧版兜底
        m.alpha_threshold = 0.35
    except Exception:
        pass
    m.use_backface_culling = False
    return m


def mk_mat_card_v(name, texfile):
    """alpha 裁切贴图 × 顶点色"""
    m = mk_mat_card(name, texfile)
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    base_link = b.inputs['Base Color'].links[0]
    src = base_link.from_socket
    nt.links.remove(base_link)
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Col'
    mix = nt.nodes.new('ShaderNodeMixRGB')
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Fac'].default_value = 1.0
    nt.links.new(src, mix.inputs['Color1'])
    nt.links.new(vc.outputs['Color'], mix.inputs['Color2'])
    nt.links.new(mix.outputs['Color'], b.inputs['Base Color'])
    return m


def mesh_from_bm(name, mat, bm, smooth=True):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    me.materials.append(mat)
    return ob


def taper(bm, p0, p1, r0, r1, seg=7):
    """两点之间的锥形（带收分）"""
    d = (Vector(p1) - Vector(p0))
    L = d.length
    if L < 1e-5:
        return
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r0, radius2=r1, depth=L)
    vs = res['verts']
    quat = Vector((0, 0, 1)).rotation_difference(d.normalized())
    mid = Vector(p0) + d * 0.5
    for v in vs:
        v.co = quat @ v.co + mid


def add_sphere(bm, c, r, sx=1.0, sy=1.0, sz=1.0, subdiv=1):
    res = bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=r)
    for v in res['verts']:
        v.co.x = v.co.x * sx + c[0]
        v.co.y = v.co.y * sy + c[1]
        v.co.z = v.co.z * sz + c[2]
    return res['verts']


def shade_canopy(ob, dark, light, rim_col, rim_amount=0.22, clusters=None, tint=0.0):
    """按高度算顶底渐变 + 边缘暖光"""
    me = ob.data
    if not me.color_attributes:
        me.color_attributes.new(name='Col', type='FLOAT_COLOR', domain='POINT')
    col = me.color_attributes['Col']
    zs = [v.co.z for v in me.vertices]
    z0, z1 = min(zs), max(zs)
    span = max(1e-4, z1 - z0)
    # 冠心（水平中心）
    xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]
    cx = (min(xs) + max(xs)) * 0.5; cy = (min(ys) + max(ys)) * 0.5
    for i, v in enumerate(me.vertices):
        t = (v.co.z - z0) / span
        t2 = t ** 0.75
        r = dark[0] + (light[0] - dark[0]) * t2
        g = dark[1] + (light[1] - dark[1]) * t2
        b = dark[2] + (light[2] - dark[2]) * t2
        # 边缘：水平方向离冠心越远、且法线朝外 → 加暖光
        n = v.normal
        dx = v.co.x - cx; dy = v.co.y - cy
        dl = math.hypot(dx, dy) + 1e-5
        outward = (n.x * dx + n.y * dy) / dl
        rim = max(0.0, outward) ** 2 * max(0.0, 0.35 + t * 0.65)
        r += rim_col[0] * rim * rim_amount
        g += rim_col[1] * rim * rim_amount
        b += rim_col[2] * rim * rim_amount
        if clusters and tint > 0:
            # 最近的球团给一个固定的随机色偏（同一团内一致 → 出现「一团团」的层次）
            best, bd = None, 1e9
            for ci, (cp, cr) in enumerate(clusters):
                dd = (v.co.x - cp[0]) ** 2 + (v.co.y - cp[1]) ** 2 + (v.co.z - cp[2]) ** 2
                if dd < bd:
                    bd, best = dd, ci
            hs = ((best * 2654435761) % 1000) / 1000.0      # 稳定伪随机
            k = 1.0 + (hs - 0.5) * 2 * tint
            r *= k * (0.94 + 0.12 * hs)
            g *= k
            b *= k * (1.06 - 0.12 * hs)
        col.data[i].color = (min(1.0, r), min(1.0, g), min(1.0, b), 1.0)


# 叶片卡可用的 UV 子区（避开贴图空白角）
UV_RECTS = [(0.02, 0.28, 0.30, 0.72), (0.26, 0.30, 0.55, 0.74), (0.50, 0.28, 0.74, 0.72),
            (0.14, 0.52, 0.40, 0.95), (0.42, 0.52, 0.68, 0.95), (0.62, 0.42, 0.88, 0.86)]


def add_leaf_cards(bm, centers, radii, count, rnd, card_scale=1.0):
    """在树冠球面上挂卡片：位置取球面点，法线朝外，UV 取贴图好区域"""
    uv_layer = bm.loops.layers.uv.verify()
    for _ in range(count):
        ci = rnd.randrange(len(centers))
        c = Vector(centers[ci]); r = radii[ci]
        # 球面随机点
        u = rnd.uniform(0, 1); vv = rnd.uniform(0.05, 1.0)
        theta = 2 * math.pi * u
        phi = math.acos(1 - 2 * vv)
        n = Vector((math.sin(phi) * math.cos(theta), math.sin(phi) * math.sin(theta), math.cos(phi)))
        p = c + Vector((n.x * r * radii_scale[ci][0], n.y * r * radii_scale[ci][1], n.z * r * radii_scale[ci][2]))
        # 卡片基向量
        up = Vector((0, 0, 1))
        t1 = n.cross(up)
        if t1.length < 1e-4:
            t1 = Vector((1, 0, 0))
        t1.normalize()
        t2 = n.cross(t1).normalized()
        s = rnd.uniform(0.20, 0.38) * card_scale
        roll = rnd.uniform(0, math.pi)
        ca, sa = math.cos(roll), math.sin(roll)
        a1 = t1 * ca + t2 * sa
        a2 = -t1 * sa + t2 * ca
        quad = [p - a1 * s - a2 * s, p + a1 * s - a2 * s, p + a1 * s + a2 * s, p - a1 * s + a2 * s]
        vs = [bm.verts.new(q) for q in quad]
        f = bm.faces.new(vs)
        # UV
        rx0, ry0, rx1, ry1 = UV_RECTS[rnd.randrange(len(UV_RECTS))]
        uvs = [(rx0, ry0), (rx1, ry0), (rx1, ry1), (rx0, ry1)]
        for loop, uv in zip(f.loops, uvs):
            loop[uv_layer].uv = uv
    return bm


radii_scale = []


def build_broadleaf(seed=1, height=7.0, canopy_scale=1.0, card_count=60):
    global radii_scale
    rnd = random.Random(seed)
    objs = []
    # ---- 树干 + 主枝
    bm = bmesh.new()
    H = height
    trunk_top = H * 0.52
    taper(bm, (0, 0, 0), (0.06, 0.03, trunk_top), 0.34, 0.16, 8)
    centers, radii = [], []
    radii_scale = []
    nb = 5
    for i in range(nb):
        a = math.radians(360 * i / nb + rnd.uniform(-18, 18))
        d = rnd.uniform(0.55, 0.95)
        tip = (math.cos(a) * d, math.sin(a) * d, trunk_top + rnd.uniform(0.25, 0.75))
        taper(bm, (0.03, 0.02, trunk_top * rnd.uniform(0.62, 0.78)), tip, 0.13, 0.035, 6)
        centers.append(tip); radii.append(rnd.uniform(1.15, 1.55) * canopy_scale)
        radii_scale.append((1.0, 1.0, 0.86))
    objs.append(mesh_from_bm('trunk', mk_mat_solid('bark', (0.24, 0.19, 0.15), 0.95), bm))

    # ---- 树冠：**叶卡为主体**（对照 w3-blob：树冠就是几百片小叶子，没有可见的几何芯）
    CZ = trunk_top + 1.55 * canopy_scale
    RX, RY, RZ = 1.75 * canopy_scale, 1.65 * canopy_scale, 1.25 * canopy_scale
    # 内芯：几团很暗的球，只当遮挡体（挡住内部空腔，不参与外观）
    bm = bmesh.new()
    core = [((0.0, 0.0, CZ - 0.12 * canopy_scale), 0.55 * 0.85 * canopy_scale)]
    for k in range(4):
        th = 2 * math.pi * k / 4 + 0.4
        core.append(((math.cos(th) * 0.36 * canopy_scale, math.sin(th) * 0.36 * canopy_scale, CZ - 0.02 * canopy_scale), 0.40 * 0.85 * canopy_scale))
    for cpos, cr in core:
        add_sphere(bm, cpos, cr, 1.0, 1.0, 0.92, subdiv=1)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.02)
    canopy = mesh_from_bm('canopy', mk_mat_vcol('canopy'), bm, smooth=True)
    bpy.context.view_layer.update()
    shade_canopy(canopy, (0.028, 0.068, 0.036), (0.075, 0.150, 0.055), (1.0, 0.90, 0.62), 0.06)
    objs.append(canopy)

    # ---- 叶卡：铺在**外壳**上（中空，能透出枝和天），带每片随机明暗
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.verify()
    col_layer = bm.verts.layers.float_color.new('Col')
    NCARD = int(620 * canopy_scale * canopy_scale)
    for _ in range(NCARD):
        th = 2 * math.pi * rnd.random()
        ph = math.acos(rnd.uniform(-1, 1))
        rr = 0.58 + 0.42 * rnd.random()          # 只在 0.58~1.0 的外壳，中心留空
        px = RX * rr * math.sin(ph) * math.cos(th)
        py = RY * rr * math.sin(ph) * math.sin(th)
        pz = CZ + RZ * rr * math.cos(ph)
        p = Vector((px, py, pz))
        n = Vector((px, py, (pz - CZ) * 1.1))
        if n.length < 1e-4:
            n = Vector((0, 0, 1))
        n.normalize()
        up = Vector((0, 0, 1))
        t1 = n.cross(up)
        if t1.length < 1e-4:
            t1 = Vector((1, 0, 0))
        t1.normalize()
        t2 = n.cross(t1).normalized()
        s = rnd.uniform(0.24, 0.44) * canopy_scale
        roll = rnd.uniform(0, math.pi)
        ca, sa = math.cos(roll), math.sin(roll)
        a1 = t1 * ca + t2 * sa
        a2 = -t1 * sa + t2 * ca
        quad = [p - a1 * s - a2 * s, p + a1 * s - a2 * s, p + a1 * s + a2 * s, p - a1 * s + a2 * s]
        vs = [bm.verts.new(q) for q in quad]
        # 每片卡的明暗：外层亮、内层暗；再叠一点高度（顶部暖亮）
        hz = (p.z - CZ) / max(1e-3, RZ)
        shade = 0.55 + 0.26 * (rr - 0.58) / 0.42 + 0.30 * max(0.0, hz) + rnd.uniform(-0.10, 0.10)
        shade = max(0.30, min(1.45, shade))
        for v in vs:
            v[col_layer] = (shade * 0.96, shade, shade * 0.88, 1.0)
        f = bm.faces.new(vs)
        rx0, ry0, rx1, ry1 = UV_RECTS[rnd.randrange(len(UV_RECTS))]
        for loop, uv in zip(f.loops, [(rx0, ry0), (rx1, ry0), (rx1, ry1), (rx0, ry1)]):
            loop[uv_layer].uv = uv
    cards = mesh_from_bm('leaf-cards', mk_mat_card_v('leafcard', 'leaf-atlas.png'), bm, smooth=False)
    objs.append(cards)
    objs.append(cards)
    return objs


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
                              export_apply=True, export_yup=True,
                              export_vertex_color='MATERIAL')
    return p



def build_tree_lod(seed=101, height=7.0, canopy_scale=1.0):
    """远景 LOD：同轮廓，几张大叶片卡 + 低模团块，目标 ~300 三角面"""
    global radii_scale
    rnd = random.Random(seed)
    objs = []
    H = height
    trunk_top = H * 0.52
    # 树干（6 边）
    bm = bmesh.new()
    taper(bm, (0, 0, 0), (0.05, 0.02, trunk_top), 0.32, 0.17, 6)
    for i in range(3):
        a = math.radians(120 * i + 15)
        taper(bm, (0, 0, trunk_top * 0.72),
              (math.cos(a) * 0.7, math.sin(a) * 0.7, trunk_top + 0.55), 0.12, 0.035, 5)
    objs.append(mesh_from_bm('trunk', mk_mat_solid('bark', (0.24, 0.19, 0.15), 0.95), bm))

    # 团块：4 个八面体级球（subdiv 0 = 20 面）
    bm = bmesh.new()
    CZ = trunk_top + 1.55 * canopy_scale
    RX, RY, RZ = 1.7 * canopy_scale, 1.6 * canopy_scale, 1.2 * canopy_scale
    blobs = [((0, 0, CZ), 1.55 * canopy_scale)]
    for i in range(3):
        a = math.radians(120 * i + 30)
        blobs.append(((math.cos(a) * 0.95 * canopy_scale, math.sin(a) * 0.95 * canopy_scale,
                       CZ - 0.02 * canopy_scale), 0.85 * 0.85 * canopy_scale))
    for cpos, cr in blobs:
        add_sphere(bm, cpos, cr, 1.0, 1.0, 0.85, subdiv=0)
    canopy = mesh_from_bm('canopy', mk_mat_vcol('canopy'), bm, smooth=True)
    bpy.context.view_layer.update()
    shade_canopy(canopy, (0.085, 0.175, 0.185), (0.430, 0.560, 0.235), (1.0, 0.96, 0.72), 0.10, clusters=blobs, tint=0.16)
    objs.append(canopy)

    # 大叶片卡：14 张，铺在冠表
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.verify()
    col_layer = bm.verts.layers.float_color.new('Col')
    for _ in range(18):
        th = 2 * math.pi * rnd.random()
        ph = math.acos(rnd.uniform(-1, 1))
        rr = rnd.uniform(0.72, 1.0)
        p = Vector((RX * rr * math.sin(ph) * math.cos(th),
                    RY * rr * math.sin(ph) * math.sin(th),
                    CZ + RZ * rr * math.cos(ph)))
        n = Vector((p.x, p.y, (p.z - CZ) * 1.1)).normalized()
        up = Vector((0, 0, 1))
        t1 = n.cross(up)
        if t1.length < 1e-4:
            t1 = Vector((1, 0, 0))
        t1.normalize()
        t2 = n.cross(t1).normalized()
        s = rnd.uniform(0.62, 0.95) * canopy_scale
        roll = rnd.uniform(0, math.pi)
        ca, sa = math.cos(roll), math.sin(roll)
        a1 = (t1 * ca + t2 * sa) * s
        a2 = (-t1 * sa + t2 * ca) * s
        quad = [p - a1 - a2, p + a1 - a2, p + a1 + a2, p - a1 + a2]
        vs = [bm.verts.new(q) for q in quad]
        hz = (p.z - CZ) / max(1e-3, RZ)
        shade = 0.55 + 0.26 * (rr - 0.72) / 0.28 + 0.30 * max(0.0, hz) + rnd.uniform(-0.10, 0.10)
        warm = max(0.0, hz)
        for v in vs:
            v[col_layer] = (shade * (0.92 + 0.30 * warm), shade * (0.98 + 0.06 * warm), shade * (1.02 - 0.22 * warm), 1.0)
        f2 = bm.faces.new(vs)
        rx0, ry0, rx1, ry1 = UV_RECTS[rnd.randrange(len(UV_RECTS))]
        for loop, uv in zip(f2.loops, [(rx0, ry0), (rx1, ry0), (rx1, ry1), (rx0, ry1)]):
            loop[uv_layer].uv = uv
    objs.append(mesh_from_bm('leaf-cards', mk_mat_card_v('leafcard', 'leaf-atlas.png'), bm, smooth=False))
    return objs

def build_conifer(seed=301, height=9.0, scale=1.0, cards_per_tier=78, tiers=7):
    """针叶 v2：尖塔形，叶卡逐层外挂 + 暗芯锥体，色调比阔叶冷"""
    rnd = random.Random(seed)
    objs = []
    H = height
    # 树干：细长直杆
    bm = bmesh.new()
    taper(bm, (0, 0, 0), (0, 0, H * 0.92), 0.22 * scale, 0.06 * scale, 7)
    objs.append(mesh_from_bm('trunk', mk_mat_solid('bark', (0.22, 0.19, 0.17), 0.95), bm))

    # 暗芯：三层锥体（低面数，只做遮挡）
    bm = bmesh.new()
    core_tiers = [(H * 0.18, 0.86 * scale, H * 0.46), (H * 0.42, 0.62 * scale, H * 0.40), (H * 0.62, 0.38 * scale, H * 0.30)]
    for (z0, r0, h) in core_tiers:
        res = bmesh.ops.create_cone(bm, cap_ends=True, segments=7, radius1=r0, radius2=0.02, depth=h)
        for v in res['verts']:
            v.co.x *= scale; v.co.y *= scale
            v.co.z = v.co.z * scale + z0 + h / 2
    core = mesh_from_bm('canopy', mk_mat_vcol('canopy'), bm, smooth=True)
    bpy.context.view_layer.update()
    # 冷色调：底部蓝绿暗 -> 顶部青绿，蓝通道保持高
    shade_canopy(core, (0.055, 0.145, 0.175), (0.135, 0.275, 0.225), (0.85, 0.95, 1.0), 0.10)

    objs.append(core)

    # 叶卡：每层一圈，向下倾斜，半径随高度递减
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.verify()
    col_layer = bm.verts.layers.float_color.new('Col')
    for ti in range(tiers):
        t = ti / max(1, tiers - 1)
        z = H * (0.16 + 0.78 * t)
        ring_r = (1.42 - 1.02 * t) * scale
        n = max(9, int(cards_per_tier * (1.0 - 0.5 * t)))
        for k in range(n):
            a = 2 * math.pi * k / n + rnd.uniform(-0.12, 0.12)
            # 卡：外沿下垂
            outx, outy = math.cos(a), math.sin(a)
            px = outx * ring_r * rnd.uniform(0.72, 1.0)
            py = outy * ring_r * rnd.uniform(0.72, 1.0)
            p = Vector((px, py, z + rnd.uniform(-0.16, 0.16) * scale))
            # 法线朝外并向下（像枝条）
            nrm = Vector((outx, outy, -0.55)).normalized()
            up = Vector((0, 0, 1))
            t1 = nrm.cross(up)
            if t1.length < 1e-4:
                t1 = Vector((1, 0, 0))
            t1.normalize()
            t2 = nrm.cross(t1).normalized()
            s = rnd.uniform(0.42, 0.68) * scale * (1.0 - 0.30 * t)
            roll = rnd.uniform(0, math.pi)
            ca, sa = math.cos(roll), math.sin(roll)
            a1 = (t1 * ca + t2 * sa) * s
            a2 = (-t1 * sa + t2 * ca) * s
            quad = [p - a1 - a2, p + a1 - a2, p + a1 + a2, p - a1 + a2]
            vs = [bm.verts.new(q) for q in quad]
            hz = max(0.0, (p.z / H - 0.16) / 0.78)
            shade = 0.58 + 0.34 * hz + rnd.uniform(-0.08, 0.08)
            for v in vs:
                # 冷：蓝通道不随高度下降
                v[col_layer] = (shade * (0.82 + 0.12 * hz), shade * (0.96 + 0.04 * hz), shade * (1.06 - 0.06 * hz), 1.0)
            f2 = bm.faces.new(vs)
            rx0, ry0, rx1, ry1 = UV_RECTS[rnd.randrange(len(UV_RECTS))]
            for loop, uv in zip(f2.loops, [(rx0, ry0), (rx1, ry0), (rx1, ry1), (rx0, ry1)]):
                loop[uv_layer].uv = uv
    objs.append(mesh_from_bm('leaf-cards', mk_mat_card_v('leafcard', 'leaf-atlas.png'), bm, smooth=False))
    return objs
if __name__ == '__main__':
    report = []
    for name, kw in [
        ('tree-broadleaf-a', dict(seed=1, height=7.0, canopy_scale=1.0, card_count=140)),
        ('tree-broadleaf-b', dict(seed=7, height=8.0, canopy_scale=1.12, card_count=155)),
    ]:
        reset()
        objs = build_broadleaf(**kw)
        tris = sum(tri_count(o) for o in objs)
        xs, ys, zs = [], [], []
        for o in objs:
            for c in o.bound_box:
                w = o.matrix_world @ Vector(c)
                xs.append(w.x); ys.append(w.y); zs.append(w.z)
        size = [round(max(xs) - min(xs), 2), round(max(ys) - min(ys), 2), round(max(zs) - min(zs), 2)]
        p = export(objs, name, OUT)
        report.append({'file': name + '.glb', 'triangles': tris, 'bytes': os.path.getsize(p), 'size_m': size})
        print('EXPORT', name, tris, 'tris', '%.2fx%.2fx%.2f' % tuple(size))
    for name, kw in [('veg-tree-conifer', dict(seed=301, height=9.0, scale=1.0)), ('veg-tree-conifer-lod', dict(seed=301, height=9.0, scale=1.0, cards_per_tier=10, tiers=4))]:
        reset()
        objs = build_conifer(**kw) if name.startswith('veg-tree-conifer') else build_tree_lod(**kw)
        tris = sum(tri_count(o) for o in objs)
        xs, ys, zs = [], [], []
        for o in objs:
            for c2 in o.bound_box:
                w = o.matrix_world @ Vector(c2)
                xs.append(w.x); ys.append(w.y); zs.append(w.z)
        size = [round(max(xs) - min(xs), 2), round(max(ys) - min(ys), 2), round(max(zs) - min(zs), 2)]
        p = export(objs, name, OUT)
        report.append({'file': name + '.glb', 'triangles': tris, 'bytes': os.path.getsize(p), 'size_m': size})
        print('EXPORT', name, tris, 'tris', '%.2fx%.2fx%.2f' % tuple(size))
    with open(os.path.join(OUT, 'tree-report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print('DONE')












