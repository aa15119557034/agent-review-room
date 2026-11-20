"""立面模块预览（近景 + 斜角）"""
import bpy, os, math

OUT = r"E:\agent-review-room\.tmp\blender-blocks\out"
SHOT = r"E:\agent-review-room\.tmp\blender-blocks\facade-preview.png"

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x = 1200
sc.render.resolution_y = 900

w = bpy.data.worlds.new('W'); sc.world = w
w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.52, 0.58, 0.70, 1)
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.2

bpy.ops.import_scene.gltf(filepath=os.path.join(OUT, 'street-facade-01.glb'))

ld = bpy.data.lights.new('sun', 'SUN'); ld.energy = 3.5
lo = bpy.data.objects.new('sun', ld); bpy.context.collection.objects.link(lo)
lo.rotation_euler = (math.radians(62), 0, math.radians(-35))

cd = bpy.data.cameras.new('cam'); co = bpy.data.objects.new('cam', cd)
bpy.context.collection.objects.link(co); sc.camera = co
cd.lens = 40
co.location = (22, -34, 15)
co.rotation_euler = (math.radians(76), 0, math.radians(30))

# 地面
bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, 0))
gp = bpy.context.active_object
gm = bpy.data.materials.new('ground'); gm.use_nodes = True
gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.30, 0.31, 0.33, 1)
gp.data.materials.append(gm)

sc.render.filepath = SHOT
bpy.ops.render.render(write_still=True)
print('RENDERED', SHOT)

