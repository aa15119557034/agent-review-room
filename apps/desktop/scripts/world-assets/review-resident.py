"""Render the same authored resident in neutral and seated-reading poses."""
import bpy,math,json
from pathlib import Path
from mathutils import Vector,Matrix,Quaternion
role=globals().get('WORLD_ROLE','claude');out=Path(globals()['WORLD_OUTPUT'])
scene=bpy.data.scenes['World_Character_Studio'];rig=bpy.data.objects['WorldArt_'+role+'_Rig'];ob=bpy.data.objects['WorldArt_'+role+'_Character']
def camera(pos,target,scale,x=1024,y=1024):
    scene.camera.location=pos;scene.camera.rotation_euler=(Vector(target)-scene.camera.location).to_track_quat('-Z','Y').to_euler();scene.camera.data.ortho_scale=scale;scene.render.resolution_x=x;scene.render.resolution_y=y
def render(name):
    scene.render.filepath=str(out/(role+'-'+name+'.png'));bpy.ops.render.render(write_still=True)
def pose(seated=False,read=False):
    rig.location=(0,0,-.29 if seated else 0)
    for bone in rig.pose.bones:bone.rotation_quaternion=Quaternion();bone.rotation_euler=(0,0,0)
    ob.data.shape_keys.key_blocks['Seated_Cloth'].value=1 if seated else 0
    bpy.context.view_layer.update()
    for side,suffix in ((1,'l'),(-1,'r')):
        desired=[('upperarm',(side*.06,-.36 if read else -.025,-1)),('lowerarm',(-side*.28 if read else side*.08,-.9 if read else -.08,-.05 if read else -1)),('thigh',(0,-1 if seated else 0,-.27 if seated else -1)),('calf',(0,0,-1))]
        for name,vector in desired:
            pb=rig.pose.bones[name+'_'+suffix];rest=pb.bone.matrix_local.to_quaternion();direction=(pb.bone.tail_local-pb.bone.head_local).normalized();rot=direction.rotation_difference(Vector(vector).normalized())@rest
            head=pb.head.copy();pb.matrix=Matrix.Translation(head)@rot.to_matrix().to_4x4();bpy.context.view_layer.update()
def box(name,size,pos,color):
    x,y,z=[v/2 for v in size];mesh=bpy.data.meshes.new(name)
    mesh.from_pydata([(-x,-y,-z),(x,-y,-z),(x,y,-z),(-x,y,-z),(-x,-y,z),(x,-y,z),(x,y,z),(-x,y,z)],[],[(3,2,1,0),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)])
    obj=bpy.data.objects.new(name,mesh);scene.collection.objects.link(obj);obj.location=pos
    mat=bpy.data.materials.new(name);mat.use_nodes=True;node=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED');node.inputs['Base Color'].default_value=color;node.inputs['Roughness'].default_value=.8;mesh.materials.append(mat)
    mod=obj.modifiers.new('Soft edge',next(i.identifier for i in bpy.types.ObjectModifiers.bl_rna.functions['new'].parameters['type'].enum_items if i.identifier=='BEVEL'));mod.width=.045;mod.segments=4
    for p in mesh.polygons:p.use_smooth=True
    return obj
pose();camera((.6,-3.2,1.65),(0,-.01,1.49),.64);render('review-face')
camera((1.4,-4,1.86),(0,0,.92),2.02,960,1200);render('review-full')
camera((3,-1.2,1.9),(0,0,.94),2.02,960,1200);render('review-side')
pose(True,True)
seat=box('WorldStudio_Seat',(.90,.72,.10),(0,.08,.40),(.16,.28,.25,1));back=box('WorldStudio_Back',(.90,.10,.72),(0,.39,.83),(.16,.28,.25,1))
for x in (-.35,.35):
    for y in (-.19,.35):box('WorldStudio_ChairLeg',(.05,.05,.35),(x,y,.175),(.16,.11,.065,1))
left=rig.matrix_world@rig.pose.bones['hand_l'].head;right=rig.matrix_world@rig.pose.bones['hand_r'].head;mid=(left+right)*.5
book=box('WorldStudio_ReadBook',(.31,.22,.008),(mid.x,mid.y-.055,mid.z+.036),(.27,.12,.06,1));book.modifiers[0].width=.003;book.rotation_euler.x=.15
bottom=box('WorldStudio_ReadBottom',(.31,.22,.008),(mid.x,mid.y-.055,mid.z+.012),(.27,.12,.06,1));bottom.modifiers[0].width=.003;bottom.rotation_euler.x=.15
pages=box('WorldStudio_ReadPages',(.29,.205,.020),(mid.x,mid.y-.055,mid.z+.024),(.8,.72,.57,1));pages.modifiers[0].width=.002;pages.rotation_euler.x=.15
camera((2.1,-3.7,2.05),(0,-.08,.70),1.72,1024,1024);render('review-seated')
camera((3.6,-.5,1.4),(0,-.08,.7),1.65,1024,1024);render('review-seat-side')
pose();print('REVIEW_RENDERED',role)
