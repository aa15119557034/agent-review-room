"""Editable low cascade shrubs with tapered twigs and individually modeled leaf blades."""
from math import atan2, cos, degrees, pi, sin
from pathlib import Path
from random import Random
import runpy
import sys

import bpy
from mathutils import Vector


ROOT = Path(__file__).parent
NAME = 'cascade-shrubs'
SHARED = runpy.run_path(str(ROOT / 'build-foliage.py'))
RAIL = runpy.run_path(str(ROOT / 'build-rail-leaf-sprays.py'))
Mesh, linear, mix = (SHARED[key] for key in ('Mesh', 'linear', 'mix'))
STEM = (linear('344136'), linear('617450'))
SHADE = linear('2f4940')
MIDDLE = linear('425c43')
LIT = linear('61784c')
LEAF_TINTS = tuple(linear(pigment) for pigment in ('3a6c56', '789353', 'a3b76a', '4c805f'))

# Overlapping volumes leave the dark gaps around the real leaf sprouts. X, Y, Z centers in Blender.
VARIANTS = {
    'cascade-spreading': [
        ((-.23, .02, .245), (.42, .31, .28)), ((.27, -.04, .205), (.37, .36, .235)),
        ((.04, .19, .375), (.32, .27, .22)), ((.45, .17, .16), (.23, .21, .19)),
    ],
    'cascade-upright': [
        ((-.27, -.07, .215), (.34, .29, .255)), ((.04, -.02, .370), (.33, .31, .335)),
        ((.32, .13, .240), (.28, .26, .265)), ((-.12, .21, .48), (.25, .23, .27)),
    ],
}


def mound(mesh, center, axes, phase):
    origin = Vector(center)
    rx, ry, rz = axes
    side_count = 10
    start = len(mesh.points)
    for row, (height, radius, shade) in enumerate(((-.80, .49, .0), (-.46, .88, .19),
                                                  (.03, 1., .46), (.55, .83, .67), (.84, .48, .84))):
        points, colors = [], []
        for j in range(side_count):
            a = 2 * pi * j / side_count + row * .12 + phase
            ripple = 1 + .10 * sin(j * 2.41 + phase + row * .9)
            points.append(origin + Vector((rx * radius * ripple * cos(a), ry * radius * ripple * sin(a),
                                           rz * (height + .10 * cos(2 * a + phase)))))
            colors.append(mix(mix(SHADE, MIDDLE, shade), LIT, shade * (.34 + .14 * cos(a))))
        ring = mesh.vertices(points, colors)
        if row:
            for j in range(side_count):
                k = (j + 1) % side_count
                mesh.faces.append((ring - side_count + j, ring - side_count + k, ring + k, ring + j))
    low = mesh.vertices([origin - Vector((0, 0, rz))], [SHADE])
    top = mesh.vertices([origin + Vector((0, 0, rz))], [mix(MIDDLE, LIT, .63)])
    for j in range(side_count):
        k = (j + 1) % side_count
        mesh.faces.extend(((low, start + k, start + j), (top, ring + j, ring + k)))


def bough(mesh, center, axes, heading, rise, scale, rng):
    rx, ry, rz = axes
    azimuth = heading * pi / 180
    outward = Vector((cos(azimuth), sin(azimuth), 0))
    origin = Vector(center)
    start = origin + Vector((rx * outward.x * .12, ry * outward.y * .12, -rz * .26))
    join = origin + Vector((rx * outward.x * .59, ry * outward.y * .59, rz * rise))
    tip = join + outward * (.15 * scale) + Vector((0, 0, .05 * rise * scale))
    mesh.fork([start, join, tip], [.014 * scale, .008 * scale, .0025 * scale], 4, STEM)
    fan = ((.23, -55, -10, .205, .064, 62),
           (.62, 48, 14, .237, .074, -46),
           (.96, -2, 1, .278, .078, 30))
    for leaf_index, (off, yaw, pitch, length, width, roll) in enumerate(fan):
        root = join.lerp(tip, off)
        first_vertex = len(mesh.points)
        turn = roll if rise < .4 else roll * .52
        RAIL['leaf'](mesh, root, heading + yaw + rng.uniform(-12, 12), pitch + rise * 38 + rng.uniform(-9, 9),
                     length * scale, width * scale, turn + rng.uniform(-15, 15), rng.uniform(0, 6.3))
        leaf_tint = rng.choice(LEAF_TINTS)
        strength = .22 if leaf_index == 2 else .13
        mesh.colors[first_vertex:] = [mix(color, leaf_tint, strength) for color in mesh.colors[first_vertex:]]


def build_source():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.name = 'Cascade Bank Shrubs'
    paint = SHARED['material']('cascade-bank-leaf-painted')
    paint.use_backface_culling = True
    for index, (name, lobes) in enumerate(VARIANTS.items()):
        rng = Random(63 + index * 29)
        mesh = Mesh()
        for j, (center, radii) in enumerate(lobes):
            x, y, z = center
            mound(mesh, (x, y, z - .04), tuple(radius * fraction for radius, fraction in zip(radii, (.58, .61, .60))),
                  rng.uniform(-pi, pi))
            # A fork into the dark heart supports the smaller fans from below.
            mesh.fork([(x * .54, y * .40, .015), (x * .78, y * .68, z * .41), (x, y, z + .025)],
                      [.019, .014, .010], 5, STEM)
            heading = degrees(atan2(y - .07, x - .058))
            for bearing, rise, size in ((-54, -.36, .87), (37, -.12, .98), (-9, .27, 1.03), (134, .62, .91)):
                bough(mesh, center, radii, heading + bearing + rng.uniform(-14, 14), rise, size * rng.uniform(.91, 1.09), rng)
        floor = min(p.z for p in mesh.points)
        mesh.points = [p - Vector((0, 0, floor)) for p in mesh.points]
        obj = mesh.object(name, paint, True)
        obj.location.x = index * 1.76
        obj['leafCount'] = 48
        obj.data.color_attributes.active_color = obj.data.color_attributes['PlantColor']
    bpy.ops.object.select_all(action='DESELECT')
    bpy.data.objects['cascade-spreading'].select_set(True)
    bpy.context.view_layer.objects.active = bpy.data.objects['cascade-spreading']
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == 'VIEW_3D':
                space = area.spaces.active
                space.region_3d.view_location = (.85, 0, .48)
                space.region_3d.view_distance = 4.5
                space.region_3d.view_rotation = Vector((1.0, -4.2, 2.7)).to_track_quat('Z', 'Y')
                space.shading.type = 'SOLID'
                space.shading.color_type = 'VERTEX'
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / f'{NAME}.blend'))


if __name__ == '__main__':
    if '--build-source' in sys.argv:
        build_source()
    bpy.context.window.scene = bpy.data.scenes['Cascade Bank Shrubs']
    SHARED['export_glb'](NAME, [bpy.data.objects[name] for name in VARIANTS])
