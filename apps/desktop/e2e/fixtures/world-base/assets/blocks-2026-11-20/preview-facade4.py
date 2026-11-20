"""四款立面横向拼接预览"""
import bpy, os, math

OUT = r"E:\agent-review-room\.tmp\blender-blocks\out"
SHOT = r"E:\agent-review-room\.tmp\blender-blocks\facade4-preview.png"

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x = 1600
sc.render.resolution_y = 900

w = bpy.data.worlds.new('W'); sc.world = w
w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.60, 0.72, 1)
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.15

# 按宽度依次拼接（都是 4 m 开间的倍数，可以首尾相接）
widths = {'street-facade-01': 16.0, 'street-facade-02': 20.0,
          'street-facade-03': 16.0, 'street-facade-04': 24.0}
x = -38.0
for name, wd in widths.items():
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(OUT, name + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        if o.parent is None:
            o.location.x += x + wd / 2
    x += wd

ld = bpy.data.lights.new('sun', 'SUN'); ld.energy = 3.2
lo = bpy.data.objects.new('sun', ld); bpy.context.collection.objects.link(lo)
lo.rotation_euler = (math.radians(64), 0, math.radians(-40))

bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, 0))
gp = bpy.context.active_object
gm = bpy.data.materials.new('ground'); gm.use_nodes = True
gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.28, 0.29, 0.31, 1)
gp.data.materials.append(gm)

cd = bpy.data.cameras.new('cam'); co = bpy.data.objects.new('cam', cd)
bpy.context.collection.objects.link(co); sc.camera = co
cd.lens = 42
co.location = (2, -52, 20)
co.rotation_euler = (math.radians(79), 0, 0)

sc.render.filepath = SHOT
bpy.ops.render.render(write_still=True)
print('RENDERED', SHOT)
