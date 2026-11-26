"""Build original station plants. Run with Blender 5.2 in background mode."""
from math import atan2, cos, pi, sin, sqrt
from pathlib import Path
from random import Random
from struct import pack, unpack_from
import json
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform


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


def crown_edge_accents(lobes):
    """Two interlocking solid leaf shapes at each of four outer shoulders."""
    accents = []
    for i, rise, width in ((0, .12, .34), (1, -.05, .31), (2, .35, .29), (5, .77, .27)):
        origin = Vector(lobes[i+2][0])
        direction = Vector((origin.x-.16, origin.y-.07, rise)).normalized()
        tangent = Vector((-direction.y, direction.x, 0)).normalized()
        tip = 0
        for center, extent, yaw in lobes:
            shift = origin - Vector(center)
            c, s = cos(yaw), sin(yaw)
            start = Vector(((shift.x*c+shift.y*s)/extent[0],
                            (-shift.x*s+shift.y*c)/extent[1], shift.z/extent[2]))
            ray = Vector(((direction.x*c+direction.y*s)/extent[0],
                          (-direction.x*s+direction.y*c)/extent[1], direction.z/extent[2]))
            a, b = ray.length_squared, start.dot(ray)
            discriminant = b*b - a*(start.length_squared-1)
            if discriminant >= 0:
                tip = max(tip, (-b + sqrt(discriminant))/a)
        yaw = atan2(direction.y, direction.x)
        primary = origin + direction*(tip-.07)
        secondary = origin + direction*(tip-.12) + tangent*.21 + Vector((0,0,.10))
        accents.append((primary, (width,.19,.15), yaw-.21))
        accents.append((secondary, (width*.76,.145,.125), yaw+.46))
    return accents


def crown_normal_proxy(mesh, custom=False):
    """Sample the high-resolution crown, with normals smoothed across voxel and accent edges."""
    mesh.calc_loop_triangles()
    vertices = [v.co.copy() for v in mesh.vertices]
    triangles = [tuple(t.vertices) for t in mesh.loop_triangles]
    normals = [v.normal.copy() for v in mesh.vertices]
    if custom:
        for loop in mesh.loops:
            normals[loop.vertex_index] = mesh.corner_normals[loop.index].vector.copy()
    neighbors = [[] for _ in vertices]
    for edge in mesh.edges:
        a, b = edge.vertices
        neighbors[a].append(b)
        neighbors[b].append(a)
    for _ in range(0 if custom else 7):
        normals = [n.lerp(sum((normals[i] for i in adjacent), Vector()).normalized(), .68).normalized()
                   for n, adjacent in zip(normals, neighbors)]
    surface = BVHTree.FromPolygons(vertices, triangles, all_triangles=True)

    def normal_at(point):
        hit, _, index, _ = surface.find_nearest(point)
        triangle = triangles[index]
        return barycentric_transform(hit, *(vertices[i] for i in triangle),
                                     *(normals[i] for i in triangle)).normalized()
    return normal_at


def fit_crown_surface(obj, target, normal_at, fitted_normals=False):
    low = [min(v.co[i] for v in obj.data.vertices) for i in range(3)]
    high = [max(v.co[i] for v in obj.data.vertices) for i in range(3)]
    scale = [(target[1][i]-target[0][i])/(high[i]-low[i]) for i in range(3)]
    color = obj.data.color_attributes.get('PlantColor') or obj.data.color_attributes.new(
        name='PlantColor', type='FLOAT_COLOR', domain='POINT')
    obj.data.color_attributes.active_color = color
    shade, light = linear('426e50'), linear('80a95f')
    normals = []
    for v in obj.data.vertices:
        uvw = [(v.co[i]-low[i])/(high[i]-low[i]) for i in range(3)]
        point = Vector([target[0][i] + uvw[i]*(target[1][i]-target[0][i]) for i in range(3)])
        if fitted_normals:
            normals.append(normal_at(point))
        else:
            n = normal_at(v.co)
            normals.append(Vector((n.x/scale[0], n.y/scale[1], n.z/scale[2])).normalized())
        v.co = point
        color.data[v.index].color = (*mix(shade, light, .20 + .58*uvw[2] + .07*uvw[0]), 1.0)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    obj.data.normals_split_custom_set_from_vertices(normals)
    obj.data.update()


def simplify_crown(obj, triangles):
    obj.data.calc_loop_triangles()
    simplify = obj.modifiers.new('Crown triangle budget', 'DECIMATE')
    simplify.ratio = triangles / len(obj.data.loop_triangles)
    simplify.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=simplify.name)


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
    for index, (center, axes, yaw) in enumerate(lobes + crown_edge_accents(lobes)):
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
    obj['stationCrown'] = True
    bpy.context.view_layer.objects.active = obj
    union = obj.modifiers.new('Fuse overlapping crown lobes', 'REMESH')
    union.mode = 'VOXEL'
    union.voxel_size = .075
    union.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=union.name)
    fair = obj.modifiers.new('Soften lobe junctions', 'SMOOTH')
    fair.factor = .58
    fair.iterations = 6
    bpy.ops.object.modifier_apply(modifier=fair.name)
    normal_at = crown_normal_proxy(obj.data)
    simplify_crown(obj, 524)

    # Fit both LODs to the approved near-crown envelope in Blender's Z-up coordinates.
    target = ((-2.418837,-2.181387,3.710542),(2.608605,2.398043,7.354254)) if variant else (
        (-2.501849,-1.938309,3.576386),(2.692011,2.223131,6.964900))
    fit_crown_surface(obj, target, normal_at)
    if not near:
        near_normals = crown_normal_proxy(obj.data, custom=True)
        simplify_crown(obj, 192)
        fit_crown_surface(obj, target, near_normals, fitted_normals=True)
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


def cedar_lobe(mesh, center, axes, yaw, sweep, color):
    """Round leaf volume, with a gentle droop towards the branch tip."""
    cx, cy, cz = center
    sx, sy, sz = axes
    c, s = cos(yaw), sin(yaw)
    sides, rows = 20, 12
    bottom = mesh.vertices([(cx, cy, cz - sz)], [color])
    for row in range(1, rows):
        p = -TAU/4 + row*TAU/(2*rows)
        points = []
        for j in range(sides):
            angle = TAU*j/sides
            x = sx*cos(p)*cos(angle)
            y = sy*cos(p)*sin(angle)
            points.append((cx + c*x - s*y, cy + s*x + c*y, cz + sz*sin(p) + sweep*x/sx))
        start = mesh.vertices(points, [color] * sides)
        if row == 1:
            for j in range(sides):
                mesh.faces.append((bottom, start + (j+1)%sides, start+j))
        else:
            for j in range(sides):
                k = (j+1)%sides
                mesh.faces.append((start-sides+j, start-sides+k, start+k, start+j))
    top = mesh.vertices([(cx, cy, cz + sz)], [color])
    for j in range(sides):
        mesh.faces.append((start+j, start+(j+1)%sides, top))


def cedar(mat_bark, near):
    trunk, envelope = Mesh(), Mesh()
    trunk.fork([(0, 0, 0), (.10, -.04, 1.76), (.20, .10, 3.75), (.22, .27, 5.76),
                (.38, .20, 7.41), (.35, .31, 8.53)],
               [.23, .19, .15, .10, .062, .012], 7 if near else 5, BARK)
    if near:
        trunk.fork([(.15, .05, 2.02), (.51, -.13, 2.35), (1.27, -.42, 2.48)],
                   [.067, .046, .012], 4, BARK)
        trunk.fork([(.19, .11, 2.78), (-.36, .26, 3.04), (-1.13, .39, 3.16)],
                   [.067, .046, .012], 4, BARK)

    # Swept basal boughs connect to a tapering, leaning crown. Use the same
    # high-resolution envelope for both LODs so its lobe normals stay coherent.
    lobes = [
        ((.36, -.24, 2.48), (1.95, 1.38, .57), -.15, -.22),
        ((-.79, .38, 3.12), (1.50, 1.12, .61), .37, .16),
        ((.22, .07, 3.73), (1.52, 1.33, .86), .28, -.13),
        ((.70, .17, 4.63), (1.28, 1.08, .78), -.41, -.09),
        ((-.22, .12, 5.35), (1.20, 1.03, .96), .27, .12),
        ((.37, .21, 6.32), (1.07, .92, 1.12), .36, -.13),
        ((.22, .25, 7.28), (.83, .75, .99), -.17, .05),
        ((.46, .29, 8.16), (.57, .51, .79), -.37, -.08),
        ((.47, .32, 8.71), (.26, .26, .40), -.17, .01),
    ]
    shade, light = linear('2a5548'), linear('659b56')
    for center, axes, yaw, sweep in lobes:
        cedar_lobe(envelope, center, axes, yaw, sweep, shade)
    crown = envelope.object('cedar-smooth-crown', mat_bark, True)
    crown['stationCrown'] = True
    crown['stationCrown'] = True
    bpy.context.view_layer.objects.active = crown
    fuse = crown.modifiers.new('Join cedar bough volumes', 'REMESH')
    fuse.mode = 'VOXEL'
    fuse.voxel_size = .085
    fuse.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=fuse.name)
    fair = crown.modifiers.new('Fair the crown before normal transfer', 'SMOOTH')
    fair.factor = .62
    fair.iterations = 13
    bpy.ops.object.modifier_apply(modifier=fair.name)
    normal_at = crown_normal_proxy(crown.data)

    crown.data.calc_loop_triangles()
    reduce = crown.modifiers.new('Cedar triangle budget', 'DECIMATE')
    reduce.ratio = (800 if near else 256) / len(crown.data.loop_triangles)
    reduce.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=reduce.name)
    normals = [normal_at(v.co) for v in crown.data.vertices]

    # Match the registered Blender Z-up extents and place the base exactly at z=0.
    points = [*trunk.points, *(v.co for v in crown.data.vertices)]
    low = [min(p[i] for p in points) for i in range(3)]
    high = [max(p[i] for p in points) for i in range(3)]
    wanted = (3.983, 3.660, 9.020) if near else (4.090, 3.378, 9.020)
    scale = [size / (hi-lo) for size, lo, hi in zip(wanted, low, high)]

    def fit(x, y, z):
        return x*scale[0], y*scale[1], (z-low[2])*scale[2]

    trunk.points = [fit(*p) for p in trunk.points]
    color = crown.data.color_attributes.get('PlantColor') or crown.data.color_attributes.new(
        name='PlantColor', type='FLOAT_COLOR', domain='POINT')
    crown.data.color_attributes.active_color = color
    for v in crown.data.vertices:
        v.co = fit(*v.co)
        tone = .20 + .64*max(0., min(1., (v.co.z - 2.)/6.8))
        color.data[v.index].color = (*mix(shade, light, tone), 1.)
    for poly in crown.data.polygons:
        poly.use_smooth = True
    crown.data.update()
    fitted_normals = [Vector(tuple(n[i]/scale[i] for i in range(3))).normalized() for n in normals]
    crown.data.normals_split_custom_set_from_vertices(fitted_normals)
    return [trunk.object('cedar-boughs', mat_bark, True), crown]


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
                              export_apply=True, export_yup=True, export_vertex_color='ACTIVE', export_extras=True)
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
        add_source_scene('station-cedar' if near else 'station-cedar-far', cedar(bark, near))
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
