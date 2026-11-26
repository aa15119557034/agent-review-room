"""Build original station plants. Run with Blender 5.2 in background mode."""
from math import cos, pi, sin
from pathlib import Path
from random import Random
from struct import pack, unpack_from
import json
import sys

import bpy
from mathutils import Vector


ROOT = Path(__file__).parent
TAU = 2 * pi
GALLERY_LAYOUT = {
    'canopy-a': (-10, 5), 'canopy-b': (0, 5), 'station-cedar': (10, 5),
    'canopy-a-far': (-10, -4), 'canopy-b-far': (0, -4), 'station-cedar-far': (10, -4),
    'bank-shrub-a': (-8, -10), 'bank-shrub-b': (-4, -10), 'edge-hedge': (0, -10),
    'meadow-ribbon-a': (4, -10), 'meadow-ribbon-b': (7, -10),
}


def linear(hex_rgb):
    values = [int(hex_rgb[i:i+2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v < .04045 else ((v + .055) / 1.055) ** 2.4 for v in values)


BARK = (linear('4d423a'), linear('77715b'))


def mix(low, high, t):
    return tuple(a + (b - a) * t for a, b in zip(low, high))


def material(name, atlas=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    shader = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    shader.inputs['Roughness'].default_value = .92
    colour = nodes.new('ShaderNodeVertexColor')
    colour.layer_name = 'PlantColor'
    if atlas:
        image = nodes.new('ShaderNodeTexImage')
        image.image = atlas
        product = nodes.new('ShaderNodeMixRGB')
        product.blend_type = 'MULTIPLY'
        product.inputs[0].default_value = 1
        links.new(image.outputs['Color'], product.inputs[1])
        links.new(colour.outputs['Color'], product.inputs[2])
        links.new(product.outputs[0], shader.inputs['Base Color'])
        links.new(image.outputs['Alpha'], shader.inputs['Alpha'])
        mat.use_backface_culling = False
    else:
        links.new(colour.outputs['Color'], shader.inputs['Base Color'])
    return mat


class Mesh:
    def __init__(self):
        self.points, self.faces, self.colors, self.uvs = [], [], [], []

    def vertices(self, points, colors):
        start = len(self.points)
        self.points.extend(points)
        self.colors.extend(colors)
        return start

    def fork(self, path, radii, sides, bark):
        for i, (p, radius) in enumerate(zip(path, radii)):
            previous = path[max(0, i - 1)]
            following = path[min(i + 1, len(path) - 1)]
            axis = (Vector(following) - Vector(previous)).normalized()
            side = axis.cross(Vector((0, 1, 0))).normalized()
            around = axis.cross(side)
            ring = [Vector(p) + radius * (side * cos(j * TAU / sides) + around * sin(j * TAU / sides))
                    for j in range(sides)]
            start = self.vertices(ring, [mix(bark[0], bark[1], .22 + .5 * j / sides) for j in range(sides)])
            if i:
                for j in range(sides):
                    k = (j + 1) % sides
                    self.faces.append((start - sides + j, start - sides + k, start + k, start + j))
            else:
                self.faces.append(tuple(range(start + sides - 1, start - 1, -1)))
        self.faces.append(tuple(range(start, start + sides)))

    def card(self, center, width, height, azimuth, pitch, tint, needle):
        c = Vector(center)
        u = Vector((cos(azimuth), sin(azimuth), 0)) * width
        v = Vector((-sin(azimuth) * pitch, cos(azimuth) * pitch, (1 - pitch**2) ** .5)) * height
        start = self.vertices([c-u-v, c+u-v, c+u+v, c-u+v], [tint] * 4)
        self.faces.append((start, start + 1, start + 2, start + 3))
        # Keep bilinear samples inside their own half of the atlas.
        left, right = (.505, .995) if needle else (.005, .495)
        self.uvs.extend([(left, .004), (right, .004), (right, .996), (left, .996)])

    def footprint(self, x_scale, y_scale):
        self.points = [(x*x_scale, y*y_scale, z) for x, y, z in self.points]

    def crown(self, center, axes, palette, sides, phase):
        cx, cy, cz = center
        sx, sy, sz = axes
        rings = [(-.64, .45, .15), (-.12, .96, .40), (.51, .73, .86)]
        for i, (height, width, tone) in enumerate(rings):
            points = []
            for j in range(sides):
                angle = phase + TAU*j/sides + .09*i
                wobble = 1 + .16*sin(j*2.7 + phase) + .08*cos(j*3.9)
                points.append((cx + sx*(width*wobble*cos(angle) + .15*height),
                               cy + sy*width*wobble*sin(angle), cz + sz*(height + .13*cos(angle + 1.5))))
            start = self.vertices(points, [mix(palette[0], palette[1], tone + .11*cos(j*TAU/sides + .6))
                                           for j in range(sides)])
            if i:
                for j in range(sides):
                    k = (j + 1) % sides
                    self.faces.append((start - sides + j, start - sides + k, start + k, start + j))
            else:
                self.faces.append(tuple(range(start + sides - 1, start - 1, -1)))
        self.faces.append(tuple(range(start, start + sides)))

    def object(self, name, mat, smooth):
        data = bpy.data.meshes.new(name)
        data.from_pydata(self.points, [], self.faces)
        data.update()
        obj = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(obj)
        data.materials.append(mat)
        color = data.color_attributes.new(name='PlantColor', type='FLOAT_COLOR', domain='POINT')
        for i, rgb in enumerate(self.colors):
            color.data[i].color = (*rgb, 1.0)
        if self.uvs:
            uv = data.uv_layers.new(name='UVMap')
            for i, coords in enumerate(self.uvs):
                uv.data[i].uv = coords
        for polygon in data.polygons:
            polygon.use_smooth = smooth
        return obj


def clusters(mesh, specs, near, needle, palette, seed, far_count=6, crown_light=None):
    rng = Random(seed)
    for index, (x, y, z, size) in enumerate(specs):
        count = 18 if near else far_count
        for i in range(count):
            a = i * 2.399963 + index * .72 + rng.uniform(-.21, .21)
            radial = size * rng.uniform(.18, .65)
            hz = rng.uniform(-.32, .42) * size
            center = (x + cos(a) * radial, y + sin(a) * radial * .82, z + hz)
            lit = .53 + hz / size * .47 + .13 * cos(a - .7) + rng.uniform(-.09, .09)
            if crown_light:
                floor, top = crown_light
                gradient = min(1, max(0, (center[2] - floor) / (top - floor)))
                lit += -.15 + .35 * gradient
            lit = min(.95, max(.12, lit))
            w = size * rng.uniform(.75, 1.03) * (1.0 if near else 1.14)
            h = size * rng.uniform(.47, .76) * (.86 if needle else 1)
            mesh.card(center, w, h, a + rng.uniform(-.56, .56), rng.uniform(-.52, .58),
                      mix(palette[0], palette[1], lit), needle)


def build_crown_surface(boughs, near, variant, mat):
    """Fuse an offset main crown and several bough lobes, then simplify the same surface for both LODs."""
    block = Mesh()
    neutral = linear('58804f')
    shift = .35 if variant else 0
    lobes = [
        ((.22, .07, 5.32 + shift), (1.30, 1.00, .84), .12),
        ((-.15, -.13, 5.53 + shift), (1.16, .79, .65), -.34),
    ]
    for i, (x, y, z, size) in enumerate(boughs):
        # B's high shoulders keep its long shape, while A spreads along its lower branches.
        yaw = (.45 if variant else -.08) + sin(i * 3.14 / 3) * .42
        lobes.append(((x + .06*sin(i), y, z + .13),
                      (size*(1.12 if variant else 1.25), size*.88, size*(.72 if i < 5 else .86)), yaw))
    for index, (center, axes, yaw) in enumerate(lobes):
        segments, rings = 14, 7
        cx, cy, cz = center
        sx, sy, sz = axes
        c, s = cos(yaw), sin(yaw)
        bottom = block.vertices([(cx, cy, cz-sz)], [neutral])
        for row in range(1, rings):
            p = -TAU/4 + row*TAU/(2*rings)
            points = []
            for i in range(segments):
                a = TAU*i/segments
                edge = cos(p) * (1 + .055*cos(3*a + index))
                x, y = sx*edge*cos(a), sy*edge*sin(a)
                points.append((cx + c*x - s*y + .12*sin(p), cy + s*x + c*y, cz + sz*sin(p)))
            block.vertices(points, [neutral]*segments)
        top = block.vertices([(cx, cy, cz+sz)], [neutral])
        for i in range(segments):
            j = (i + 1) % segments
            block.faces.append((bottom, bottom+1+j, bottom+1+i))
            for row in range(rings-2):
                low = bottom+1+row*segments
                high = low+segments
                block.faces.append((low+i, low+j, high+j, high+i))
            last = bottom+1+(rings-2)*segments
            block.faces.append((last+i, last+j, top))
    obj = block.object('broadleaf-smooth-crown', mat, True)
    bpy.context.view_layer.objects.active = obj
    union = obj.modifiers.new('Fuse overlapping crown lobes', 'REMESH')
    union.mode = 'VOXEL'
    union.voxel_size = .105
    union.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=union.name)
    fair = obj.modifiers.new('Soften lobe junctions', 'SMOOTH')
    fair.factor = .58
    fair.iterations = 7
    bpy.ops.object.modifier_apply(modifier=fair.name)
    obj.data.calc_loop_triangles()
    simplify = obj.modifiers.new('Crown triangle budget', 'DECIMATE')
    simplify.ratio = (524 if near else 192) / len(obj.data.loop_triangles)
    simplify.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=simplify.name)

    # Fit both LODs to the approved near-crown envelope in Blender's Z-up coordinates.
    target = ((-2.418837,-2.181387,3.710542),(2.608605,2.398043,7.354254)) if variant else (
        (-2.501849,-1.938309,3.576386),(2.692011,2.223131,6.964900))
    low = [min(v.co[i] for v in obj.data.vertices) for i in range(3)]
    high = [max(v.co[i] for v in obj.data.vertices) for i in range(3)]
    color = obj.data.color_attributes.get('PlantColor') or obj.data.color_attributes.new(
        name='PlantColor', type='FLOAT_COLOR', domain='POINT')
    obj.data.color_attributes.active_color = color
    shade, light = linear('426e50'), linear('80a95f')
    for v in obj.data.vertices:
        uvw = [(v.co[i]-low[i])/(high[i]-low[i]) for i in range(3)]
        v.co = [target[0][i] + uvw[i]*(target[1][i]-target[0][i]) for i in range(3)]
        color.data[v.index].color = (*mix(shade, light, .20 + .58*uvw[2] + .07*uvw[0]), 1.0)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    obj.data.update()
    return obj


def broadleaf(mat_bark, near, variant=False):
    trunk = Mesh()
    trunk.fork([(0, 0, 0), (.12, -.09, 1.42), (.33, .04, 2.81), (.51, .13, 4.42), (.48, .24, 5.42)],
               [.27, .22, .16, .09, .028], 8 if near else 6, BARK)
    boughs = [(1.14, -.45, 4.77, 1.02), (-.59, -.75, 4.41, .94), (-1.02, .47, 4.95, 1.10),
              (.16, .89, 5.27, 1.04), (1.12, .62, 5.45, 1.01), (.38, -.30, 5.99, .94),
              (-.50, .17, 5.58, 1.09)]
    if variant:
        boughs = [(x * 1.08 + .19 * sin(i), y * 1.06, z + .35 + .10 * cos(i), s * (1.10 if i % 2 else .94))
                  for i, (x, y, z, s) in enumerate(boughs)]
    for i, (x, y, z, size) in enumerate(boughs):
        branch_start = (.31, .025, 2.63 + i * .22)
        if near:
            trunk.fork([branch_start, (x*.53, y*.48, z-.60), (x, y, z)], [.096, .050, .013], 5, BARK)
        else:
            trunk.fork([branch_start, (x, y, z)], [.088, .013], 3, BARK)
    return [trunk.object('forked-trunk', mat_bark, True), build_crown_surface(boughs, near, variant, mat_bark)]


def cedar_shelf(mesh, center, axes, phase, palette, near):
    """A closed, lobed bough shelf. Adjacent shelves overlap around the stem."""
    cx, cy, cz = center
    sx, sy, sz = axes
    sides = 16 if near else 8
    rings = [(-.78, .36, .01), (-.42, .87, .13), (-.07, 1.0, .38),
             (.43, .79, .72), (.82, .36, 1.0)]
    if not near:
        rings = rings[::2]
    first = len(mesh.points)
    for i, (rise, width, light) in enumerate(rings):
        points, colors = [], []
        for j in range(sides):
            angle = TAU * j / sides
            u, v = cos(angle), sin(angle)
            lobe = 1 + .16 * cos(3 * (angle - phase)) + .13 * cos(2 * angle + phase) + .07 * sin(5 * angle - phase)
            shift = .20 * rise
            drape = width * (.20 * cos(angle - phase) - .09 * cos(3 * (angle - phase)))
            points.append((cx + sx * (u * width * lobe + shift * cos(phase)),
                           cy + sy * (v * width * lobe + shift * sin(phase)),
                           cz + sz * (rise - drape)))
            colors.append(mix(palette[0], palette[1], light))
        start = mesh.vertices(points, colors)
        if i:
            for j in range(sides):
                k = (j + 1) % sides
                mesh.faces.append((start - sides + j, start - sides + k, start + k, start + j))
    end = len(mesh.points) - sides
    lower = mesh.vertices([(cx - .12*sx*cos(phase), cy - .12*sy*sin(phase), cz - .96*sz)], [palette[0]])
    upper = mesh.vertices([(cx + .20*sx*cos(phase), cy + .20*sy*sin(phase), cz + .99*sz)], [palette[1]])
    for j in range(sides):
        k = (j + 1) % sides
        mesh.faces.extend([(lower, first + k, first + j), (upper, end + j, end + k)])


def cedar_leader(mesh, palette, near):
    # Follow the upright leader through connected, alternating branch shoulders.
    # Extra rings on the near mesh smooth the loft; the far mesh uses the same silhouette anchors.
    profile = [
        (.10, .16, 3.06, .49, .42, .76, .16),
        (.14, .20, 3.50, 1.24, 1.15, .82, .31),
        (.32, .30, 3.93, 1.69, 1.53, 1.59, .48),
        (.41, .29, 4.29, 1.50, 1.38, 1.91, .31),
        (.18, .23, 4.58, 1.27, 1.19, 2.65, .36),
        (-.17, .11, 4.96, 1.51, 1.33, 2.85, .50),
        (.03, .15, 5.35, 1.32, 1.23, 3.35, .57),
        (.39, .12, 5.73, 1.28, 1.15, 4.02, .48),
        (.53, .23, 6.10, 1.25, 1.19, 4.74, .59),
        (.29, .30, 6.53, 1.01, .98, 5.28, .62),
        (.15, .22, 6.94, .94, .87, 6.39, .56),
        (.19, .25, 7.30, .72, .79, 6.90, .74),
        (.42, .34, 7.69, .68, .61, 7.65, .77),
        (.28, .28, 8.08, .50, .49, 8.24, .82),
        (.35, .29, 8.42, .35, .34, 8.91, .93),
        (.48, .31, 8.72, .18, .16, 9.52, 1.0),
    ]
    if not near:
        profile = [row for i, row in enumerate(profile) if i not in (1, 3, 6, 9, 11, 14)]
    sides = 16 if near else 8
    first = len(mesh.points)
    for i, (x, y, z, sx, sy, phase, light) in enumerate(profile):
        points = []
        for j in range(sides):
            angle = TAU*j/sides
            reach = 1 + .14*cos(3*(angle - phase)) + .09*cos(2*angle + phase)
            drape = .12 * (sx + sy) * sin(angle - phase) + .065 * cos(3*angle + phase)
            points.append((x + sx*cos(angle)*reach, y + sy*sin(angle)*reach, z + drape))
        start = mesh.vertices(points, [mix(palette[0], palette[1], light)] * sides)
        if i:
            for j in range(sides):
                k = (j + 1) % sides
                mesh.faces.append((start - sides + j, start - sides + k, start + k, start + j))
    last = len(mesh.points) - sides
    base = mesh.vertices([(.09,.13,2.93)], [palette[0]])
    peak = mesh.vertices([(.43,.31,8.98)], [palette[1]])
    for j in range(sides):
        k = (j + 1) % sides
        mesh.faces.extend([(base, first + k, first + j), (peak, last + j, last + k)])


def cedar(mat_bark, mat_foliage, near):
    trunk, leaves, masses = Mesh(), Mesh(), Mesh()
    trunk.fork([(0, 0, 0), (.10, -.04, 1.76), (.20, .10, 3.75), (.22, .27, 5.76),
                (.38, .20, 7.41), (.35, .31, 8.53)],
               [.23, .19, .15, .10, .062, .012], 7 if near else 5, BARK)
    # Two low shelves branch out independently along the taller connected crown.
    shelves = [
        ((.36, -.36, 2.54), (2.34, 1.90, .72), .54),
        ((-.65, .20, 3.32), (1.75, 1.44, .71), 2.21),
    ]
    palette = (linear('2a5548'), linear('659b56'))
    cedar_leader(masses, palette, near)
    for center, size, phase in shelves:
        cedar_shelf(masses, center, size, phase, palette, near)
        if near:
            x, y, z = center
            sx, sy, sz = size
            a = phase + .6
            trunk.fork([(.18, .12, z - sz*.78), (x*.45, y*.45, z - sz*.38),
                        (x + .66*sx*cos(a), y + .66*sy*sin(a), z - sz*.27)],
                       [.067, .046, .012], 4, BARK)
            # Small fringe sprays are held at the lower branch extremities.
            for a in (phase - .23, phase + 2.37):
                leaf_center = (x + .89*sx*cos(a), y + .89*sy*sin(a), z - sz*.18)
                leaves.card(leaf_center, .20, .145, a + .50, .35, mix(*palette, .46), True)

    parts = [trunk, masses] + ([leaves] if near else [])
    points = [p for part in parts for p in part.points]
    mins = tuple(min(p[i] for p in points) for i in range(3))
    spans = tuple(max(p[i] for p in points) - mins[i] for i in range(3))
    dimensions = (3.983, 3.660, 9.020) if near else (4.090, 3.378, 9.020)
    scale = [size / span for size, span in zip(dimensions, spans)]
    for part in parts:
        part.points = [(x*scale[0], y*scale[1], (z - mins[2])*scale[2]) for x, y, z in part.points]
    objects = [trunk.object('cedar-boughs', mat_bark, True),
               masses.object('cedar-canopy-planes', mat_bark, True)]
    if near:
        objects.append(leaves.object('cedar-needle-sprays', mat_foliage, False))
    return objects


def shrub(mat_bark, mat_foliage, seed):
    twig, leaves = Mesh(), Mesh()
    rng = Random(seed)
    specs = []
    for i in range(5):
        a = i * 2.399963
        r = rng.uniform(.24, .62)
        x, y, z = cos(a)*r, sin(a)*r, rng.uniform(.42, .76)
        twig.fork([(x*.2, y*.2, 0), (x*.47, y*.48, z*.55), (x, y, z)], [.025, .018, .008], 4, BARK)
        specs.append((x, y, z, rng.uniform(.34, .52)))
    clusters(leaves, specs, False, False, (linear('4b7257'), linear('aabc76')), seed)
    return [twig.object('shrub-stems', mat_bark, True), leaves.object('shrub-leaves', mat_foliage, False)]


def hedge(mat_bark, mat_foliage):
    twig, leaves = Mesh(), Mesh()
    specs = [(-.80, -.13, .49, .46), (-.58, .18, .61, .49), (-.16, -.12, .54, .52),
             (.19, .16, .60, .47), (.57, -.20, .49, .55), (.86, .11, .61, .42)]
    # The warm evening key already adds yellow. Keep the exposed top green and push the shaded base cooler.
    core_palette = (linear('2d5745'), linear('559252'))
    leaf_palette = (linear('31654d'), linear('73bb63'))
    for x, y, z, _ in specs:
        twig.crown((x, y*.62, z*.68), (.39, .45, .51), core_palette, 5, x)
    inner = [(x*.94, y*.75, z*.62, size*.81) for x, y, z, size in specs]
    clusters(leaves, specs + inner, False, False, leaf_palette, 401277, crown_light=(.30, .83))
    twig.footprint(.82, .58)
    leaves.footprint(.82, .58)
    return [twig.object('hedge-stems', mat_bark, True), leaves.object('hedge-sprays', mat_foliage, False)]


def grass(mat, seed, height):
    mesh, rng = Mesh(), Random(seed)
    for i in range(11):
        a = rng.uniform(0, TAU)
        u = Vector((cos(a), sin(a), 0))
        w = Vector((-sin(a), cos(a), 0))
        root = u * rng.uniform(.01, .21)
        h = rng.uniform(.55, 1.0) * height
        width = rng.uniform(.018, .043)
        lean = rng.uniform(.11, .28)
        middle = root + u * lean*.32 + Vector((0, 0, h*.61))
        tip = root + u*lean + Vector((0, 0, h))
        light = rng.uniform(.44, .87)
        start = mesh.vertices([root-w*width, root+w*width, middle+w*width*.6, middle-w*width*.6, tip],
                              [linear('4b694b')]*2 + [mix(linear('597b4d'), linear('a9ad60'), light)]*3)
        mesh.faces.extend([(start, start+1, start+2, start+3), (start+3, start+2, start+4)])
    return [mesh.object('folded-ground-grass', mat, True)]


def add_source_scene(name, objects):
    source_scene = bpy.data.scenes.new(name)
    source = bpy.data.collections.new(name + '-source')
    source_scene.collection.children.link(source)
    for obj in objects:
        source.objects.link(obj)
        bpy.context.scene.collection.objects.unlink(obj)
    preview = bpy.data.objects.new(name, None)
    preview.instance_type = 'COLLECTION'
    preview.instance_collection = source
    x, y = GALLERY_LAYOUT[name]
    preview.location = (x, y, 0)
    bpy.context.scene.collection.objects.link(preview)


def export_glb(name, objects):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    target = ROOT / f'{name}.glb'
    bpy.ops.export_scene.gltf(filepath=str(target), export_format='GLB', use_selection=True, use_active_scene=True,
                              export_apply=True, export_yup=True, export_vertex_color='ACTIVE')
    if any(mat and mat.name == 'original-foliage-alpha' for obj in objects for mat in obj.data.materials):
        data = target.read_bytes()
        size = unpack_from('<I', data, 12)[0]
        source = json.loads(data[20:20+size])
        masks = [m for m in source['materials'] if m.get('name') == 'original-foliage-alpha']
        if len(masks) != 1:
            raise ValueError(f'{name}: expected one alpha foliage material')
        masks[0].update(alphaMode='MASK', alphaCutoff=.5)
        updated = json.dumps(source, separators=(',', ':')).encode()
        updated += b' ' * (-len(updated) % 4)
        payload = data[20+size:]
        target.write_bytes(pack('<4sIIII', b'glTF', 2, 20+len(updated)+len(payload), len(updated), 0x4E4F534A) +
                           updated + payload)

def build_source():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.name = 'Overview'
    bark = material('station-bark')
    sprays = material('original-foliage-alpha', bpy.data.images.load(str(ROOT / 'foliage-sprays.png')))
    ground = material('original-tapered-grass')
    for style, variant in [('canopy-a', False), ('canopy-b', True)]:
        add_source_scene(style, broadleaf(bark, True, variant))
        add_source_scene(style+'-far', broadleaf(bark, False, variant))
    for near in (True, False):
        add_source_scene('station-cedar' if near else 'station-cedar-far', cedar(bark, sprays, near))
    for kind, seed in [('bank-shrub-a', 418), ('bank-shrub-b', 919)]:
        add_source_scene(kind, shrub(bark, sprays, seed))
    add_source_scene('edge-hedge', hedge(bark, sprays))
    for kind, seed, height in [('meadow-ribbon-a', 1103, .30), ('meadow-ribbon-b', 8202, .38)]:
        add_source_scene(kind, grass(ground, seed, height))

    bpy.ops.file.pack_all()
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type != 'VIEW_3D':
                continue
            viewport = area.spaces.active
            viewport.region_3d.view_location = (0, -1.5, 3.5)
            viewport.region_3d.view_distance = 39
            viewport.region_3d.view_rotation = Vector((10, -19, 13)).to_track_quat('Z', 'Y')
            viewport.shading.type = 'MATERIAL'
    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / 'station-foliage.blend'))


if '--build-source' in sys.argv:
    build_source()
else:
    for name in GALLERY_LAYOUT:
        scene = bpy.data.scenes[name]
        bpy.context.window.scene = scene
        export_glb(name, [obj for obj in scene.objects if obj.type == 'MESH'])
