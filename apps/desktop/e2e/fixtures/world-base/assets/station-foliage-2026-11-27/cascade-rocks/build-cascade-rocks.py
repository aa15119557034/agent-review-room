"""Author fitted rock shelves. Blender +Z is up; exported glTF +Z faces the pool."""

from pathlib import Path
import sys

import bpy
from mathutils import Vector


HERE = Path(__file__).resolve().parent
BLEND = HERE / 'cascade-rocks.blend'
GLB = HERE / 'cascade-rocks.glb'


def linear(hex_rgb):
    channels = [int(hex_rgb[i:i+2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in channels)


WET = tuple(map(linear, ('515352', '5c5e5d', '686862')))
SIDES = tuple(map(linear, ('786a63', '89786e', '988475')))
BEVEL = tuple(map(linear, ('968276', 'a68e80', 'a29086')))
CAP = tuple(map(linear, ('aa9387', 'b39d91', '928179', 'a08c80')))
CLIFF_SKIRT = tuple(map(linear, ('a48675', 'b59681', 'c1a08b')))
CLIFF_SEAM = tuple(map(linear, ('94786a', 'aa8b79', 'ae917f')))


def slab(vertices, faces, pigment, contour, size, center, levels, tilt, colors, cap_order, bank):
    """Irregular broad faces, one stepped brow on the shore side, and a wetted toe."""
    n = len(contour)
    first = len(vertices)
    cx, cy, cz = center
    width, depth = size
    for y, width_ratio, depth_ratio, forward in levels:
        for x, z, crack in contour:
            px = cx + x * width * width_ratio
            pz = cz + z * depth * depth_ratio * (bank if z < 0 else 1) + forward
            # The stratum leans gently across the top rather than being concentric.
            py = cy + y + tilt[0] * x + tilt[1] * z + crack
            vertices.append((px, -pz, py))
    faces.append(tuple(first + k for k in range(n)))
    pigment.append(WET[0])
    for ring, palette in enumerate(colors):
        lower = first + ring * n
        upper = lower + n
        for k in range(n):
            nxt = (k + 1) % n
            faces.append((lower + k, upper + k, upper + nxt, lower + nxt))
            pigment.append(palette[cap_order[k] % len(palette)])
    top = first + (len(levels) - 1) * n
    apex = len(vertices)
    # Low spine with uneven shore-side falls; adjacent large faces deliberately share the same tone.
    y, *_ = levels[-1]
    vertices.append((cx + width * 0.06, -(cz - depth * 0.06), cy + y + 0.09))
    for k in range(n):
        faces.append((apex, top + (k + 1) % n, top + k))
        pigment.append(CAP[cap_order[k]])


TERRACE = [(-0.50,-0.35,0.02),(-0.31,-0.52,0.11),(0.12,-0.46,0.07),(0.48,-0.38,-0.02),
           (0.52,-0.03,0.14),(0.31,0.22,-0.09),(0.21,0.48,-0.16),(-0.11,0.51,-0.10),
           (-0.32,0.36,-0.02),(-0.49,0.17,0.08)]
TAPER = [(-0.52,-0.20,0.05),(-0.30,-0.49,0.15),(0.03,-0.52,0.14),(0.40,-0.38,0.18),
         (0.53,-0.03,0.01),(0.42,0.19,-0.05),(0.10,0.49,-0.10),(-0.14,0.40,-0.06),(-0.42,0.10,0.03)]
TONGUE = [(-0.50,-0.20,0.02),(-0.22,-0.45,0.08),(0.27,-0.42,0.04),(0.50,-0.11,0.09),
          (0.41,0.24,-0.10),(0.10,0.51,-0.26),(-0.23,0.40,-0.22),(-0.51,0.09,-0.12)]
BROKEN_TERRACE = [(-0.51,-0.29,0.11),(-0.34,-0.51,0.34),(0.02,-0.44,0.15),(0.43,-0.38,0.03),
                  (0.51,-0.04,0.23),(0.41,0.14,-0.12),(0.20,0.43,-0.33),(-0.04,0.37,-0.03),
                  (-0.24,0.51,-0.24),(-0.45,0.21,0.13),(-0.52,0.15,-0.15)]
BROKEN_TAPER = [(-0.54,-0.21,-0.01),(-0.31,-0.48,0.19),(0.03,-0.50,0.31),(0.41,-0.31,0.34),
                (0.54,-0.04,0.07),(0.41,0.10,-0.02),(0.32,0.30,-0.13),(0.06,0.47,-0.29),
                (-0.07,0.29,-0.04),(-0.35,0.22,0.09),(-0.49,0.02,0.04)]


def wall_bed(vertices, faces, pigment, sections):
    """One continuous stratum below the preserved shelf. Both ends vanish inside the cliff."""
    first = len(vertices)
    # x, brow, height, heel, foot level in local rock coordinates. The lower
    # contours follow the sampled face into the cliff instead of closing in air.
    for x, brow, y, heel, foot in sections:
        back = min(brow - 1.24, heel - 0.68)
        lip = 0.79 * brow + 0.21 * heel
        vertices.extend(((x,-back,y+0.09), (x,-brow,y), (x,-lip,0.61*y+0.39*foot),
                         (x,-heel,foot), (x,-back,foot-0.34)))
    faces.append(tuple(first + i for i in reversed(range(5))))
    pigment.append(CLIFF_SEAM[0])
    for j in range(len(sections)-1):
        base = first + 5*j
        for k, colors in enumerate((CLIFF_SKIRT, CLIFF_SKIRT, CLIFF_SEAM, CLIFF_SEAM, CLIFF_SKIRT)):
            nxt = (k+1) % 5
            faces.append((base+k, base+nxt, base+nxt+5, base+k+5))
            pigment.append(colors[(j // 2 + k) % len(colors)])
    last = first + 5*(len(sections)-1)
    faces.append(tuple(last + i for i in range(5)))
    pigment.append(CLIFF_SEAM[1])


def shape(name):
    vertices, faces, colors = [], [], []

    def add(contour, size, center, levels, tilt, bands, cap_order, bank=1):
        slab(vertices, faces, colors, contour, size, center, levels, tilt, bands, cap_order, bank)

    if name == 'cascade-terrace':
        add(BROKEN_TERRACE, (10.8, 4.6), (0,0,0),
            [(-1.55,.86,.91,-.41),(-.48,1.03,.98,.04),(.24,1.02,1.0,0),(.87,.96,.92,-.06),(1.29,.88,.81,-.25)],
            (0.30,-0.66), (WET, WET, SIDES, BEVEL), (2,2,1,1,1,0,0,3,3,2,2), 2.06)
        add(TAPER, (7.1, 3.1), (-1.17,.68,-.97),
            [(-.65,.97,.91,0),(.03,1.04,1.0,.11),(.91,.93,.86,-.03),(1.18,.86,.79,-.17)],
            (-0.55,-0.46), (SIDES, WET, BEVEL), (2,2,0,1,1,0,0,3,3), 1.64)
    elif name == 'cascade-angled-shelf':
        add(BROKEN_TAPER, (8.5, 4.2), (0,0,0),
            [(-1.44,.81,.95,-.33),(-.43,1.05,1.01,.06),(.26,1.02,.99,0),(.74,.87,.93,-.08),(1.06,.79,.76,-.24)],
            (-.31,-.50), (WET, WET, SIDES, BEVEL), (3,2,2,0,0,0,3,3,3,2,2), 2.28)
        add(TERRACE, (4.9,2.8), (1.12,.48,-.79),
            [(-.49,.91,.97,-.04),(.26,1.04,.88,-.02),(1.03,.86,.79,-.18)],
            (.21,-.52), (WET, BEVEL), (2,2,1,1,1,0,0,0,3,3), 1.78)
    elif name == 'cascade-wet-toe':
        add(TONGUE, (5.4, 3.1), (0,0,0),
            [(-.94,.81,.83,-.22),(-.36,1.01,1.02,.07),(.16,1.0,1.0,0),(.52,.91,.91,-.11)],
            (.19,-.40), (WET, WET, SIDES), (3,2,2,0,0,3,3,2))
    else:
        # Use the unaltered two top contours for every existing planting probe.
        # The narrow platform lip overlaps one broad stratum, with no separate side spikes.
        add(TERRACE, (6.1, 5.5), (0,0,-.25),
            [(.29,.93,.63,-.62),(.66,.98,.83,-.19),(.91,1.0,1.0,0),(1.32,.90,.91,-.10)],
            (.17,-.37), (CLIFF_SEAM, CLIFF_SKIRT, BEVEL), (2,2,1,1,0,0,3,3,2,2))
        add(TAPER, (3.64, 2.88), (-.90,.78,-.77),
            [(-.7,.91,.91,-.10),(.40,1.05,.98,0),(.83,.89,.82,-.08)],
            (-.25,-.50), (SIDES, BEVEL), (2,2,1,1,0,0,3,3,2))
        wall_bed(vertices, faces, colors, [(-6.80,-2.07,.78,-2.54,-.08),(-5.74,-1.37,.98,-1.83,-.02),
                 (-4.73,-.43,1.07,-1.02,-.12),(-3.55,.44,.97,-.48,-.19),(-2.66,1.00,.73,-.27,-.27),
                 (-1.30,1.87,.75,-.24,-.34),(.14,2.06,.71,-.19,-.36),(1.52,1.83,.68,-.21,-.24),
                 (2.83,1.39,.74,-.18,-.26),(3.92,.78,.88,-.40,-.17),
                 (5.15,.49,.97,-.49,-.22),(6.18,-.13,.91,-.77,-.11),(7.02,-.73,.77,-1.26,-.22)])
    return vertices, faces, colors


NAMES = ('cascade-terrace', 'cascade-angled-shelf', 'cascade-wet-toe', 'cascade-high-ledge')


def paint_and_normals(mesh, colors):
    # Adjacent stone planes share their border colour. Preserve some face direction
    # in the split normals so the warm terraces soften without reading as pillows.
    rgb = [Vector((0,0,0)) for _ in mesh.vertices]
    weights = [0.0 for _ in mesh.vertices]
    for polygon, paint in zip(mesh.polygons, colors):
        polygon.use_smooth = True
        weight = max(0.0001, polygon.area) ** 0.39
        for i in polygon.vertices:
            rgb[i] += Vector(paint) * weight
            weights[i] += weight
    mesh.update()
    layer = mesh.color_attributes.new(name='StonePaint', type='FLOAT_COLOR', domain='POINT')
    mesh.color_attributes.active_color = layer
    for i, color in enumerate(rgb):
        layer.data[i].color = (*(color / weights[i]), 1.0)
    normals = [None] * len(mesh.loops)
    for polygon in mesh.polygons:
        for i in polygon.loop_indices:
            smooth = mesh.vertices[mesh.loops[i].vertex_index].normal
            normals[i] = polygon.normal.lerp(smooth, 0.76).normalized()
    mesh.normals_split_custom_set(normals)


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    mat = bpy.data.materials.new('Warm canyon strata')
    mat.use_nodes = True
    shader = next(node for node in mat.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
    shader.inputs['Roughness'].default_value = 1.0
    attribute = mat.node_tree.nodes.new('ShaderNodeVertexColor')
    attribute.layer_name = 'StonePaint'
    mat.node_tree.links.new(attribute.outputs['Color'], shader.inputs['Base Color'])
    for index, name in enumerate(NAMES):
        verts, faces, colors = shape(name)
        mesh = bpy.data.meshes.new(f'{name} carved faces')
        mesh.from_pydata(verts, [], faces)
        if mesh.validate():
            raise ValueError(f'{name} had invalid faces')
        mesh.update()
        paint_and_normals(mesh, colors)
        mesh.materials.append(mat)
        obj = bpy.data.objects.new(name, mesh)
        obj.location.x = index * 13.0
        bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = bpy.data.objects[NAMES[0]]
    bpy.data.objects[NAMES[0]].select_set(True)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))


def export():
    bpy.ops.object.select_all(action='DESELECT')
    for name in NAMES:
        obj = bpy.data.objects[name]
        obj.location = (0,0,0)
        obj.select_set(True)
        obj.data.calc_loop_triangles()
        print(f'{name}: {len(obj.data.loop_triangles)} triangles')
    bpy.ops.export_scene.gltf(filepath=str(GLB), export_format='GLB', use_selection=True, export_yup=True, export_apply=True)


if '--export-only' not in sys.argv:
    build()
export()
