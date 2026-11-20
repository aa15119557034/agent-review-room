import sys, json, struct, hashlib, io
from pathlib import Path
from PIL import Image
import numpy as np
fixture=Path(sys.argv[1])
out=Path(sys.argv[2])
pins={'v2':'3ef6196ee62ad3b1bf9cfda4ea0feac017ccb64aac208ef4b8b82df0f7ea9d13','final':'e4ed22eacde7fc320637468a794fcd99d01c0344a0458adcc214d6c78bd7b54d'}
assets={}
for ver,pin in pins.items():
    loc=fixture/'.local/station-art-releases'/pin/'.local/mature-sakura/mature-sakura.glb'
    data=loc.read_bytes()
    jl,jt=struct.unpack_from('<II',data,12)
    gltf=json.loads(data[20:20+jl]); b=data[28+jl:]
    images=[]
    for img in gltf['images']:
        bv=gltf['bufferViews'][img['bufferView']]; pos=bv.get('byteOffset',0); encoded=b[pos:pos+bv['byteLength']]
        with Image.open(io.BytesIO(encoded)) as im:
            a=np.array(im.convert('RGBA'))[:,:,3]
            images.append(dict(name=img.get('name'),size=list(im.size),pngHash=hashlib.sha256(encoded).hexdigest(),bytes=len(encoded),alphaHistogram=np.bincount(a.ravel(),minlength=256).tolist()))
    roles=[]
    for nd in gltf['nodes']:
        if 'mesh' not in nd: continue
        mesh=gltf['meshes'][nd['mesh']]
        for prim in mesh['primitives']:
            mat=gltf['materials'][prim['material']];pbr=mat['pbrMetallicRoughness']; t=gltf['textures'][pbr['baseColorTexture']['index']]['source']; img=images[t]; mode=mat.get('alphaMode','OPAQUE');cut=mat.get('alphaCutoff',0.5)
            pos=gltf['accessors'][prim['attributes']['POSITION']];uv=gltf['accessors'][prim['attributes']['TEXCOORD_0']]
            roles.append(dict(node=nd['name'],role=nd.get('extras',{}).get('role'),tri=gltf['accessors'][prim['indices']]['count']//3,verts=pos['count'],xyzBounds=[pos['min'],pos['max']],uvBounds=[uv.get('min'),uv.get('max')],material=mat.get('name'),materialIndex=prim['material'],alphaMode=mode,cutoff=cut if mode=='MASK' else None,doubleSided=mat.get('doubleSided',False),image=t,aboveCutoff=sum(img['alphaHistogram'][int(np.ceil(cut*255)):])/sum(img['alphaHistogram']) if mode=='MASK' else None))
    assets[ver]=dict(zipSHA256=pin,glbSHA256=hashlib.sha256(data).hexdigest(),images=images,roles=roles)
out.write_text(json.dumps(assets,ensure_ascii=False,indent=2),encoding='utf8')
for ver,rows in assets.items():
    print(ver)
    for r in rows['roles']:print(r['node'],r['tri'],r['material'],r['image'],r['cutoff'],r['aboveCutoff'],rows['images'][r['image']]['size'])
