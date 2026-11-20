"""六款远景高楼预览"""
import bpy, os, math

OUT = r"E:\agent-review-room\.tmp\blender-blocks\out"
SHOT = r"E:\agent-review-room\.tmp\blender-blocks\towers-preview.png"

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x = 1600
sc.render.resolution_y = 900

w = bpy.data.worlds.new('W'); sc.world = w
w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.62, 0.74, 1)
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.15

names = ['skyline-tower-slim-tank', 'skyline-tower-slim-billboard',
         'skyline-tower-slab-tank', 'skyline-tower-slab-billboard',
         'skyline-tower-setback-tank', 'skyline-tower-setback-billboard']
wids = [25, 25, 40, 40, 30, 30]
gap = 14
x = -110.0
for name, wd in zip(names, wids):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(OUT, name + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        if o.parent is None:
            o.location.x += x + wd / 2
    x += wd + gap

ld = bpy.data.lights.new('sun', 'SUN'); ld.energy = 3.4
lo = bpy.data.objects.new('sun', ld); bpy.context.collection.objects.link(lo)
lo.rotation_euler = (math.radians(60), 0, math.radians(-38))

bpy.ops.mesh.primitive_plane_add(size=800, location=(0, 0, 0))
gp = bpy.context.active_object
gm = bpy.data.materials.new('ground'); gm.use_nodes = True
gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.30, 0.32, 0.34, 1)
gp.data.materials.append(gm)

cd = bpy.data.cameras.new('cam'); co = bpy.data.objects.new('cam', cd)
bpy.context.collection.objects.link(co); sc.camera = co
cd.lens = 42
co.location = (0, -360, 96)
co.rotation_euler = (math.radians(85), 0, 0)

sc.render.filepath = SHOT
bpy.ops.render.render(write_still=True)
print('RENDERED', SHOT)

