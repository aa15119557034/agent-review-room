import bpy, os, math
OUT = r"E:\agent-review-room\.tmp\blender-blocks\out\props"
SHOT = r"E:\agent-review-room\.tmp\blender-blocks\props-sheet.png"
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x = 1800
sc.render.resolution_y = 900
sc.view_settings.view_transform = 'Standard'
sc.view_settings.look = 'None'
w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.42, 0.48, 0.58, 1)
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6

row1 = [('prop-pole-a',2.6),('prop-pole-b',2.6),('prop-wire-span',20.0),('prop-vending-drinks',2.0),('prop-vending-coffee',2.0)]
row2 = [('prop-postbox',1.8),('prop-sign-speed',1.8),('prop-sign-blue',2.4),('prop-sign-warning',1.8),('prop-sign-stop',1.8),('prop-guardrail',2.6),('prop-hydrant',1.8)]

def place(files, y):
    total = sum(s for _, s in files) + 1.4 * (len(files) - 1)
    x = -total / 2
    for f, span in files:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(OUT, f + '.glb'))
        for o in [o for o in bpy.data.objects if o not in before]:
            if o.parent is None:
                o.location.x += x + span * 0.5
                o.location.y += y
        x += span + 1.4

place(row1, 6.0)
place(row2, -6.0)

ld = bpy.data.lights.new('sun','SUN'); ld.energy = 2.4
lo = bpy.data.objects.new('sun', ld); bpy.context.collection.objects.link(lo)
lo.rotation_euler = (math.radians(58), 0, math.radians(-38))
bpy.ops.mesh.primitive_plane_add(size=500, location=(0,0,0))
gp = bpy.context.active_object
gm = bpy.data.materials.new('g'); gm.use_nodes = True
gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.44,0.46,0.48,1)
gm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.95
gp.data.materials.append(gm)
cd = bpy.data.cameras.new('c'); co = bpy.data.objects.new('c', cd)
bpy.context.collection.objects.link(co); sc.camera = co
cd.lens = 30
co.location = (0, -34, 22.0)
co.rotation_euler = (math.radians(58), 0, 0)
sc.render.filepath = SHOT
bpy.ops.render.render(write_still=True)
print('RENDERED', SHOT)
