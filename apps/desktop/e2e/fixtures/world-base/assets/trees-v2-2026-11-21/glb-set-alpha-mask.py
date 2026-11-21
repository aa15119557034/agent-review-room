"""glb-set-alpha-mask.py —— 把 GLB 里指定材质的 alphaMode 改成 MASK（alphaCutoff 0.5）
Blender 5.2 的 glTF 导出器不管 surface_render_method 怎么设都会输出 BLEND，
对树叶卡这种「要硬裁切」的素材不对（BLEND 会有排序问题和半透明边缘）。
直接改 GLB 的 JSON chunk，其余不动。
用法：python glb-set-alpha-mask.py <glob> [材质名...]
"""
import sys, json, struct, glob, os

def patch(path, names, cutoff=0.5):
    data = open(path, 'rb').read()
    magic, ver, total = struct.unpack('<III', data[:12])
    assert magic == 0x46546C67, 'not a GLB'
    off = 12
    chunks = []
    while off < len(data):
        clen, ctype = struct.unpack('<II', data[off:off + 8])
        chunks.append((ctype, data[off + 8:off + 8 + clen]))
        off += 8 + clen
    jchunk = chunks[0]
    js = json.loads(jchunk[1].decode('utf-8'))
    changed = []
    for m in js.get('materials', []):
        if names and m.get('name') not in names:
            continue
        if m.get('alphaMode') == 'MASK':
            continue
        m['alphaMode'] = 'MASK'
        m['alphaCutoff'] = cutoff
        changed.append(m.get('name'))
    if not changed:
        return []
    newj = json.dumps(js, separators=(',', ':')).encode('utf-8')
    newj += b' ' * ((4 - len(newj) % 4) % 4)
    out = [struct.pack('<II', len(newj), 0x4E4F534A) + newj]
    for ctype, cl in chunks[1:]:
        pad = b'\x00' * ((4 - len(cl) % 4) % 4)
        out.append(struct.pack('<II', len(cl) + len(pad), ctype) + cl + pad)
    body = b''.join(out)
    header = struct.pack('<III', 0x46546C67, 2, 12 + len(body))
    open(path, 'wb').write(header + body)
    return changed

if __name__ == '__main__':
    pattern = sys.argv[1]
    names = sys.argv[2:]
    if not names:
        names = ['leafcard', 'grasscard', 'flowercard']
    for p in sorted(glob.glob(pattern)):
        ch = patch(p, names)
        print(os.path.basename(p), '→', ch if ch else '（无需改）')
