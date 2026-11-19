"""Reproducible art review lighting. Only touches the dedicated WorldArt studio."""
import bpy, math
from mathutils import Vector
from pathlib import Path
scene=bpy.data.scenes['World_Character_Studio'];bpy.context.window.scene=scene
for ob in list(scene.objects):
    if ob.name.startswith('WorldStudio_'):bpy.data.objects.remove(ob,do_unlink=True)
for ob in scene.objects:
    if ob.type=='MESH' and ob.data.shape_keys:
        for key in ob.data.shape_keys.key_blocks:key.value=0
world=bpy.data.worlds.get('WorldStudio_World') or bpy.data.worlds.new('WorldStudio_World');scene.world=world;world.use_nodes=True
background=next(n for n in world.node_tree.nodes if n.type=='BACKGROUND');background.inputs['Color'].default_value=(.24,.28,.32,1);background.inputs['Strength'].default_value=.45
def aim(ob,at):ob.rotation_euler=(Vector(at)-ob.location).to_track_quat('-Z','Y').to_euler()
for name,pos,energy,size,color in [('Key',(-2.2,-3.5,4.0),350,3.0,(1,.87,.72)),('Fill',(2.6,-1.4,2.4),170,3.0,(.76,.85,1)),('Rim',(1.2,2.0,3.0),420,2.4,(1,.83,.66))]:
    data=bpy.data.lights.new('WorldStudio_'+name,'AREA');data.energy=energy;data.shape=next(i.identifier for i in bpy.types.AreaLight.bl_rna.properties['shape'].enum_items if i.identifier=='DISK');data.size=size;data.color=color;data.use_shadow_jitter=True
    ob=bpy.data.objects.new(data.name,data);scene.collection.objects.link(ob);ob.location=pos;aim(ob,(0,0,1.0))
data=bpy.data.cameras.new('WorldStudio_Camera');cam=bpy.data.objects.new(data.name,data);scene.collection.objects.link(cam);scene.camera=cam
cam.location=(2.15,-4.9,2.05);aim(cam,(0,0,.94));cam.data.type=next(i.identifier for i in bpy.types.Camera.bl_rna.properties['type'].enum_items if i.identifier=='ORTHO');cam.data.ortho_scale=2.08
mesh=bpy.data.meshes.new('WorldStudio_Ground');mesh.from_pydata([(-200,-200,-.008),(200,-200,-.008),(200,200,-.008),(-200,200,-.008)],[],[(0,1,2,3)])
floor=bpy.data.objects.new('WorldStudio_Ground',mesh);scene.collection.objects.link(floor)
mat=bpy.data.materials.get('WorldStudio_Backdrop') or bpy.data.materials.new('WorldStudio_Backdrop');mat.use_nodes=True;node=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED');node.inputs['Base Color'].default_value=(.26,.30,.29,1);node.inputs['Roughness'].default_value=.9;mesh.materials.append(mat)
scene.render.resolution_x=960;scene.render.resolution_y=1200;scene.render.resolution_percentage=100
scene.render.image_settings.file_format=next(i.identifier for i in bpy.types.ImageFormatSettings.bl_rna.properties['file_format'].enum_items if i.identifier=='PNG')
# OCIO dynamic enums are not fully exposed by RNA; preserve the installed AgX.
scene.view_settings.exposure=0
scene.eevee.shadow_ray_count=min(8,scene.eevee.bl_rna.properties['shadow_ray_count'].hard_max)
scene.eevee.shadow_step_count=min(12,scene.eevee.bl_rna.properties['shadow_step_count'].hard_max)
scene.eevee.taa_render_samples=128
print('STUDIO_READY',scene.render.engine)
