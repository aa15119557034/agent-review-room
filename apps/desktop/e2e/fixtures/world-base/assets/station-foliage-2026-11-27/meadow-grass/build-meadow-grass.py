"""Build the folded grass fans and short sward, with editable source and no textures."""

from math import cos, pi, sin
from pathlib import Path
from random import Random
import sys

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'meadow-grass.blend'
RINGS = (0.0, 0.23, 0.48, 0.72, 0.90, 1.0)
WIDTH = (0.62, 0.98, 0.91, 0.64, 0.30, 0.018)


def linear(value):
    channels = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels)


def mix(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


BASE = linear('395747')
SHADE_TIP = linear('729576')
SUN_TIP = linear('adad72')
SWARD_BASE = linear('4a7465')
SWARD_SHADE = linear('83b58e')
SWARD_SUN = linear('b5c177')


def blade_geometry(seed, count, height, reach, gust, sward=False):
    rng = Random(seed)
    vertices, faces, color = [], [], []
    golden_angle = pi * (3 - 5 ** 0.5)
    rings = (0.0, 0.43, 0.77, 1.0) if sward else RINGS
    profile = (0.52, 0.98, 0.67, 0.021) if sward else WIDTH
    for blade in range(count):
        angle = blade * golden_angle + rng.uniform(-0.50, 0.50)
        out = Vector((cos(angle), sin(angle), 0.0))
        side = Vector((-out.y, out.x, 0.0))
        outer = blade >= count // 2
        start = out * rng.uniform(0.025, 0.15 if outer else 0.085)
        if sward:
            # Distribute roots over the whole tile and shift across its ragged border, not just around a shared centre.
            spread = ((blade + 0.5) / count) ** 0.5 * rng.uniform(0.77, 1.20)
            start += Vector((0.66 * out.x, 0.52 * out.y, 0.0)) * spread
        scale = rng.uniform(0.61, 0.87) if outer else rng.uniform(0.76, 1.0)
        blade_height = height * scale
        blade_reach = reach * (rng.uniform(0.78, 1.18) if outer else rng.uniform(0.24, 0.72))
        width = rng.uniform(0.020, 0.039)
        if sward:
            width *= rng.uniform(0.44, 0.78)
        twist = rng.uniform(-0.48, 0.51)
        warm = rng.uniform(0.09, 0.69)
        base = SWARD_BASE if sward else BASE
        top = mix(SWARD_SHADE, SWARD_SUN, warm) if sward else mix(SHADE_TIP, SUN_TIP, warm)
        base_index = len(vertices)
        for ring, t in enumerate(rings):
            # The centre curves out from its foot and bends into the group direction near the tip.
            center = start + out * (blade_reach * t ** 1.66) + Vector((gust * t * t, 0.06 * t * t, 0.0))
            center.z = blade_height * (1.17 * t - 0.17 * t ** 3 - 0.18 * max(0, t - 0.63) ** 2)
            arm = (cos(t * twist) * side + sin(t * twist) * Vector((0, 0, 1))) * (width * profile[ring])
            crease = out * (width * profile[ring] * 0.49)
            vertices.extend([center - arm, center + crease, center + arm, center - crease * 0.22])
            blade_color = mix(base, top, t ** 0.79)
            for shade in (0.97, 1.13, 1.02, 0.84):
                color.append((*[c * shade for c in blade_color], 1.0))
        faces.append(tuple(base_index + k for k in reversed(range(4))))
        for ring in range(len(rings) - 1):
            a = base_index + ring * 4
            b = a + 4
            for k in range(4):
                nxt = (k + 1) % 4
                faces.append((a + k, a + nxt, b + nxt, b + k))
        end = base_index + (len(rings) - 1) * 4
        faces.append(tuple(end + k for k in range(4)))
    return vertices, faces, color


MODELS = (
    ('meadow-grass-fan', 10521, 13, 0.47, 0.22, 0.07, False),
    ('meadow-grass-sweep', 20847, 12, 0.39, 0.25, -0.15, False),
    ('meadow-sward-low', 49281, 27, 0.205, 0.13, 0.038, True),
    ('meadow-sward-bowed', 92746, 30, 0.255, 0.18, -0.071, True),
)


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    material = bpy.data.materials.new('Painted blade colour')
    material.use_nodes = True
    nodes = material.node_tree.nodes
    shader = next(node for node in nodes if node.type == 'BSDF_PRINCIPLED')
    shader.inputs['Roughness'].default_value = 1.0
    pigment = nodes.new('ShaderNodeVertexColor')
    pigment.layer_name = 'BladePigment'
    material.node_tree.links.new(pigment.outputs['Color'], shader.inputs['Base Color'])

    for index, (name, seed, count, height, reach, gust, sward) in enumerate(MODELS):
        vertices, faces, color = blade_geometry(seed, count, height, reach, gust, sward)
        mesh = bpy.data.meshes.new(name + ' · closed folded blades')
        mesh.from_pydata(vertices, [], faces)
        mesh.validate()
        mesh.update()
        pigment_data = mesh.color_attributes.new(name='BladePigment', type='FLOAT_COLOR', domain='POINT')
        mesh.color_attributes.active_color = pigment_data
        for i, value in enumerate(color):
            pigment_data.data[i].color = value
        mesh.materials.append(material)
        obj = bpy.data.objects.new(name, mesh)
        obj.location.x = 1.60 * index
        obj['blade_count'] = count
        obj['author_hint'] = 'Each folded blade is a disconnected closed mesh. Use Select Linked to edit its silhouette.'
        bpy.context.scene.collection.objects.link(obj)
        if index == 0:
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE))


def export():
    for name, *_ in MODELS:
        bpy.ops.object.select_all(action='DESELECT')
        obj = bpy.data.objects[name]
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        original = obj.location.copy()
        obj.location = (0.0, 0.0, 0.0)
        obj.data.calc_loop_triangles()
        try:
            bpy.ops.export_scene.gltf(filepath=str(ROOT / f'{name}.glb'), export_format='GLB',
                                      use_selection=True, export_yup=True, export_apply=True)
        finally:
            obj.location = original
        print(f'{name}: {obj["blade_count"]} closed blades, {len(obj.data.loop_triangles)} triangles')


if '--export-only' not in sys.argv:
    build()
export()
