"""Export only the authored resident; preserve the current studio pose."""
import bpy,json
from pathlib import Path
from mathutils import Quaternion
role=globals().get('WORLD_ROLE','claude');prefix='WorldArt_'+role
destination=Path(globals()['WORLD_EXPORT']).resolve();destination.parent.mkdir(parents=True,exist_ok=True)
collection=bpy.data.collections[prefix];rig=bpy.data.objects[prefix+'_Rig'];mesh=bpy.data.objects[prefix+'_Character']
location=rig.location.copy();poses={b.name:b.matrix_basis.copy() for b in rig.pose.bones};values={k.name:k.value for k in mesh.data.shape_keys.key_blocks}
rig.location=(0,0,0)
for b in rig.pose.bones:b.matrix_basis.identity()
for k in mesh.data.shape_keys.key_blocks:k.value=0
for ob in bpy.context.scene.objects:ob.select_set(False)
for ob in collection.all_objects:ob.select_set(True)
bpy.context.view_layer.objects.active=rig;bpy.context.view_layer.update()
# GLB was discovered from this installed operator's TypeError list because its
# dynamic RNA enum list is empty in Blender 5.2. The remaining defaults are read.
props=bpy.ops.export_scene.gltf.get_rna_type().properties
bpy.ops.export_scene.gltf(filepath=str(destination),export_format='GLB',use_selection=True,use_active_scene=True,export_animations=False,export_extras=True,export_skins=True,export_morph=True,export_morph_normal=True,export_all_vertex_colors=True,export_vertex_color=props['export_vertex_color'].default,export_apply=False)
rig.location=location
for b in rig.pose.bones:b.matrix_basis=poses[b.name]
for k in mesh.data.shape_keys.key_blocks:k.value=values[k.name]
bpy.context.view_layer.update()
print('RESIDENT_EXPORTED',json.dumps({'role':role,'path':str(destination),'bytes':destination.stat().st_size}))
