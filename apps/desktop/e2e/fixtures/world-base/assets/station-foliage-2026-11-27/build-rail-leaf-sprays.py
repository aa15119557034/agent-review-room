"""Model the rail verge's three leaf sprays, or export the edited Blender source."""
from math import cos, radians, sin
from pathlib import Path
import runpy
import sys

import bpy
from mathutils import Quaternion, Vector


ROOT = Path(__file__).parent
NAME = 'rail-leaf-sprays'
SHARED = runpy.run_path(str(ROOT / 'build-foliage.py'))
Mesh, linear, mix = (SHARED[key] for key in ('Mesh', 'linear', 'mix'))
UP = Vector((0, 0, 1))

# Position on the twig, heading and pitch in degrees, length, half width, and surface roll.
# Long boxwood-like leaves, slightly rounded accent leaves and younger narrow leaves share a twig.
SPRAYS = {
    'spray-spreading': (
        ((0, 0, 0), (.075, -.014, .035), (.156, .002, .072), (.246, .031, .112)),
        ((.38, -70, 13, .138, .041, 24), (.50, 81, 24, .151, .046, -29),
         (.66, -48, 22, .176, .049, 35), (.78, 62, 18, .152, .047, -21),
         (.93, -14, 34, .168, .044, -18)),
    ),
    'spray-rising': (
        ((0, 0, 0), (.052, .032, .056), (.126, .051, .135), (.193, .041, .205)),
        ((.35, 76, 30, .121, .037, -18), (.49, -64, 17, .152, .041, 17),
         (.60, 96, 45, .148, .041, -30), (.78, -59, 37, .168, .042, 36),
         (.90, 56, 51, .116, .034, -12), (1., 9, 55, .146, .036, 14)),
    ),
    'spray-tipped': (
        ((0, 0, 0), (.092, -.029, .019), (.171, -.030, .065), (.248, -.008, .102)),
        ((.39, 72, 16, .161, .045, -28), (.48, -97, 22, .121, .042, 29),
         (.61, 56, 29, .176, .052, 38), (.74, -66, 11, .148, .048, 25),
         (.87, 49, 31, .155, .048, -28), (1., -9, 23, .187, .050, -12)),
    ),
}

# Closed cross-section. The top has one turned edge, broad shoulders and a raised midrib.
BLADE_SECTION = ((-1., 0.), (-.69, -.07), (0., -.14), (.70, -.08), (1., 0.),
                 (.68, .065), (.06, .235), (-.53, .14))
PROFILE = ((.11, .29), (.26, .72), (.43, 1.), (.60, .89), (.77, .64), (.90, .32))
SHADE = linear('356052')
COOL_FACE = linear('587e57')
WARM_FACE = linear('8aab63')
LIT_EDGE = linear('b6cb78')
VEIN = linear('a1bb73')
STEM = (linear('485647'), linear('6a7854'))


def twig_point(points, position):
    index = min(int(position * 3), 2)
    return Vector(points[index]).lerp(Vector(points[index + 1]), position * 3 - index)


def leaf(mesh, root, heading, pitch, length, width, roll, variation):
    direction = Vector((cos(radians(heading)) * cos(radians(pitch)),
                        sin(radians(heading)) * cos(radians(pitch)), sin(radians(pitch))))
    side = UP.cross(direction).normalized()
    face = direction.cross(side).normalized()
    tilt = Quaternion(direction, radians(roll))
    side, face = tilt @ side, tilt @ face
    root_vertex = mesh.vertices([root], [mix(SHADE, COOL_FACE, .38)])
    previous = None
    section_count = len(BLADE_SECTION)
    for u, shape in PROFILE:
        curve = .13 * sin(u * 2.62) - .05 * u * u
        shift = width * .36 * sin(u * 2.31 + variation) * u
        center = root + direction * (u * length) + face * (length * curve) + side * shift
        points, colors = [], []
        for j, (across, relief) in enumerate(BLADE_SECTION):
            asymmetric = 1 + .10 * across * sin(u * 4.2 + variation)
            bend = .07 * across * across * sin(u * 4.4 + variation)
            points.append(center + side * (width * shape * across * asymmetric)
                          + face * (width * shape * (relief + bend)))
            if j in (1, 2, 3):
                tone = mix(SHADE, COOL_FACE, .30 + .37 * u)
            elif j == 6:
                tone = mix(WARM_FACE, VEIN, .56 - .20 * u)
            else:
                face_tone = .25 + .52 * u + .12 * sin(variation + u * 2.3)
                tone = mix(COOL_FACE, WARM_FACE, face_tone if across < 0 else face_tone + .17)
                if j == 4:
                    tone = mix(tone, LIT_EDGE, .39)
            colors.append(tone)
        start = mesh.vertices(points, colors)
        for j in range(section_count):
            k = (j + 1) % section_count
            if previous is None:
                mesh.faces.append((root_vertex, start + k, start + j))
            else:
                mesh.faces.append((previous + j, previous + k, start + k, start + j))
        previous = start
    tip = root + direction * length + face * (length * .013) + side * (width * .20 * sin(variation))
    tip_vertex = mesh.vertices([tip], [mix(WARM_FACE, LIT_EDGE, .45)])
    for j in range(section_count):
        mesh.faces.append((previous + j, previous + ((j + 1) % section_count), tip_vertex))


def build_source():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = 'Rail Leaf Sprays'
    paint = SHARED['material']('rail-leaf-painted')
    paint.use_backface_culling = True
    for index, (name, (twig, blades)) in enumerate(SPRAYS.items()):
        mesh = Mesh()
        mesh.fork(twig, [.010, .008, .005, .0024], 5, STEM)
        for number, (at, heading, pitch, length, width, roll) in enumerate(blades):
            root = twig_point(twig, at)
            neck = root + .029 * Vector((cos(radians(heading)), sin(radians(heading)), .28))
            mesh.fork([root, neck], [.0042, .0031], 4, STEM)
            leaf(mesh, neck, heading, pitch, length, width, roll, 1.21 * index + number * .66)
        obj = mesh.object(name, paint, True)
        obj.location.x = index * .64
        obj['leafCount'] = len(blades)
        obj['purpose'] = 'Opaque modeled leaf spray for the R4 rail verge'
        obj.data.color_attributes.active_color = obj.data.color_attributes['PlantColor']
    bpy.ops.object.select_all(action='DESELECT')
    bpy.data.objects['spray-spreading'].select_set(True)
    bpy.context.view_layer.objects.active = bpy.data.objects['spray-spreading']
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == 'VIEW_3D':
                view = area.spaces.active
                view.region_3d.view_location = (.76, 0, .12)
                view.region_3d.view_distance = 2.55
                view.region_3d.view_rotation = Vector((.7, -1.8, 2.1)).to_track_quat('Z', 'Y')
                view.shading.type = 'SOLID'
                view.shading.color_type = 'VERTEX'
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / f'{NAME}.blend'))


if __name__ == '__main__':
    if '--build-source' in sys.argv:
        build_source()
    bpy.context.window.scene = bpy.data.scenes['Rail Leaf Sprays']
    SHARED['export_glb'](NAME, [bpy.data.objects[name] for name in SPRAYS])
