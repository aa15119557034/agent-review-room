"""Fit new, smooth street-tree crowns to the old assets' exact silhouette bounds."""
import runpy
import sys
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parent
LEGACY = ROOT.parent / 'vegetation-2026-11-21'
AUTHORING = runpy.run_path(str(ROOT / 'build-foliage.py'))
RECIPES = {
    'street-young-crown': {
        'legacy': 'veg-tree-young.glb',
        'lobes': [
            ((.06, -.02, .17), (.48, .46, .56)),
            ((-.49, .12, -.14), (.41, .35, .36)),
            ((.46, .20, -.20), (.42, .41, .39)),
            ((.19, -.49, -.03), (.37, .39, .37)),
            ((-.24, -.23, .40), (.34, .31, .42)),
            ((.30, .35, .43), (.32, .29, .35)),
            ((-.71, .07, -.19), (.19, .15, .17)),
            ((.57, .37, -.35), (.20, .16, .19)),
            ((.28, -.64, -.14), (.19, .17, .17)),
        ],
        'palette': ('426e50', '80a95f'),
        'triangles': 448,
        'smoothing': 4,
        'forks': True,
    },
    'island-cherry-crown': {
        'legacy': 'veg-tree-cherry.glb',
        'lobes': [
            ((.03, .06, .09), (.64, .55, .55)),
            ((-.48, -.13, -.12), (.46, .46, .45)),
            ((.48, .17, -.16), (.53, .45, .38)),
            ((.20, -.46, -.10), (.45, .47, .44)),
            ((-.24, .48, -.19), (.44, .43, .38)),
            ((.16, -.06, .39), (.46, .43, .47)),
            ((-.46, .16, .26), (.36, .36, .32)),
        ],
        'palette': ('a86990', 'f1b7c9'),
        'triangles': 320,
    },
}


def make_fork_tips(lower, upper, material):
    center = (lower + upper) / 2
    height = upper.z - lower.z
    bark = ((.84, .82, .83), (1.0, .98, .97))
    branches = AUTHORING['Mesh']()
    for direction, angle, depth in [(-1, .07, .09), (1, -.17, .02)]:
        spread = upper.x - lower.x
        root = (center.x, center.y, lower.z - .17 + depth)
        shoulder = (center.x + direction * spread * .13, center.y + angle * .45, lower.z + height * .13 + depth)
        tip = (center.x + direction * spread * .26, center.y + angle, lower.z + height * .38 + depth)
        branches.fork([root, shoulder, tip], [.048, .036, .017], 5, bark)
    branches.object('young-fork-tips', material, True)


def build_variant(name, recipe):
    scene = bpy.data.scenes.new(name)
    bpy.context.window.scene = scene
    bpy.ops.import_scene.gltf(filepath=str(LEGACY / recipe['legacy']))
    meshes = [obj for obj in scene.objects if obj.type == 'MESH']
    old_crowns = [obj for obj in meshes if obj.name.startswith('canopy')]
    trunks = [obj for obj in meshes if obj.name.startswith('trunk')]
    if not old_crowns or len(trunks) != 1:
        raise ValueError(f'{name}: expected crown meshes and one legacy trunk')
    positions = [obj.matrix_world @ vertex.co for obj in old_crowns for vertex in obj.data.vertices]
    lower = Vector(tuple(min(point[axis] for point in positions) for axis in range(3)))
    upper = Vector(tuple(max(point[axis] for point in positions) for axis in range(3)))
    center, half_size = (lower + upper) / 2, (upper - lower) / 2
    crown_parts = []
    for offset, radii in recipe['lobes']:
        position = center + Vector(tuple(size * amount for size, amount in zip(half_size, offset)))
        bpy.ops.mesh.primitive_uv_sphere_add(segments=14, ring_count=8, location=position)
        obj = bpy.context.object
        obj.scale = tuple(size * radius for size, radius in zip(half_size, radii))
        crown_parts.append(obj)
    bpy.ops.object.select_all(action='DESELECT')
    for part in crown_parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = crown_parts[0]
    bpy.ops.object.join()
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    crown = bpy.context.object
    crown.name = name
    crown['stationCrown'] = True
    crown.data.materials.append(AUTHORING['material'](name + '-paint'))
    union = crown.modifiers.new('Fuse canopy lobes', 'REMESH')
    union.mode = 'VOXEL'
    union.voxel_size = min(half_size) / 14
    union.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=union.name)
    fair = crown.modifiers.new('Smooth lobe joins', 'SMOOTH')
    fair.factor = .58
    fair.iterations = recipe.get('smoothing', 6)
    bpy.ops.object.modifier_apply(modifier=fair.name)
    normal_at = AUTHORING['crown_normal_proxy'](crown.data)
    AUTHORING['simplify_crown'](crown, recipe['triangles'])
    AUTHORING['fit_crown_surface'](crown, (lower, upper), normal_at, palette=recipe['palette'])
    if recipe.get('forks'):
        make_fork_tips(lower, upper, trunks[0].data.materials[0])
    for obj in old_crowns:
        bpy.data.objects.remove(obj, do_unlink=True)
    return scene


if '--build-source' in sys.argv:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, recipe in RECIPES.items():
        build_variant(name, recipe)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / 'street-crowns.blend'))
for name in RECIPES:
    bpy.context.window.scene = bpy.data.scenes[name]
    AUTHORING['export_glb'](name, [obj for obj in bpy.context.scene.objects if obj.type == 'MESH'])
