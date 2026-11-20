#!/usr/bin/env python3
"""X-51 改前/改后逐像素比对 + 五项验收的量化部分。

对应 C酱 要的五条：
  1. B 便利店平台接缝（y=660-690, x≈572-592 局部）
  2. W1 #16 浮空（世界坐标投影点附近局部）
  3. D 洗衣店室内（门内区域亮度）
  4. 其他店室内逐像素一致（整图差异统计 + 变化区域定位）
  5. 新增 RGB 三通道 ≥250 的近白像素

用法：python x51-diff.py --shots <dir> --summary <cand-summary.json> --views a,b,c
"""
import argparse
import json
import os

import numpy as np
from PIL import Image

NEAR_WHITE = 250
DIFF_TOL = 2          # 任一通道差 > 2 记作变化


def load(p):
    return np.asarray(Image.open(p).convert('RGB')).astype(np.int16)


def diff_stats(base, cand):
    d = np.abs(base - cand)
    dm = d.max(axis=2)
    mask = dm > DIFF_TOL
    out = {
        'changed_pixels': int(mask.sum()),
        'changed_ratio': round(float(mask.mean()), 6),
        'max_channel_diff': int(dm.max()),
        'mean_diff_changed': round(float(dm[mask].mean()), 3) if mask.any() else 0.0,
    }
    if mask.any():
        ys, xs = np.where(mask)
        out['bbox'] = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
        my, mx = np.unravel_index(int(dm.argmax()), dm.shape)
        out['max_at'] = [int(mx), int(my)]
    else:
        out['bbox'] = None
        out['max_at'] = None
    return out, dm, mask


def near_white_stats(base, cand):
    bw = (base >= NEAR_WHITE).all(axis=2)
    cw = (cand >= NEAR_WHITE).all(axis=2)
    added = cw & ~bw
    out = {
        'base_count': int(bw.sum()),
        'cand_count': int(cw.sum()),
        'added_count': int(added.sum()),
        'added_ratio': round(float(added.mean()), 6),
    }
    if added.any():
        ys, xs = np.where(added)
        out['added_bbox'] = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
    return out


def region_stats(base, cand, box, label):
    x0, y0, x1, y1 = box
    x0 = max(0, x0); y0 = max(0, y0)
    x1 = min(base.shape[1], x1); y1 = min(base.shape[0], y1)
    if x1 <= x0 or y1 <= y0:
        return {'label': label, 'note': 'out of frame'}
    b = base[y0:y1, x0:x1]
    c = cand[y0:y1, x0:x1]
    d = np.abs(b - c).max(axis=2)
    bl = (0.2126 * b[:, :, 0] + 0.7152 * b[:, :, 1] + 0.0722 * b[:, :, 2]) / 255.0
    cl = (0.2126 * c[:, :, 0] + 0.7152 * c[:, :, 1] + 0.0722 * c[:, :, 2]) / 255.0
    return {
        'label': label,
        'box': [x0, y0, x1, y1],
        'lum_base': round(float(bl.mean()), 4),
        'lum_cand': round(float(cl.mean()), 4),
        'lum_delta': round(float(cl.mean() - bl.mean()), 4),
        'changed_ratio': round(float((d > DIFF_TOL).mean()), 6),
        'max_diff': int(d.max()),
    }


def save_heat(dm, path):
    h = np.clip(dm * 8, 0, 255).astype(np.uint8)
    rgb = np.dstack([h, np.zeros_like(h), np.zeros_like(h)])
    Image.fromarray(rgb).save(path)


def save_crop_pair(base, cand, box, path, scale=3):
    x0, y0, x1, y1 = box
    x0 = max(0, x0); y0 = max(0, y0)
    x1 = min(base.shape[1], x1); y1 = min(base.shape[0], y1)
    if x1 <= x0 or y1 <= y0:
        return False
    b = Image.fromarray(base[y0:y1, x0:x1].astype(np.uint8))
    c = Image.fromarray(cand[y0:y1, x0:x1].astype(np.uint8))
    w, h = b.size
    canvas = Image.new('RGB', (w * 2 + 8, h), (20, 20, 20))
    canvas.paste(b, (0, 0))
    canvas.paste(c, (w + 8, 0))
    if scale > 1:
        canvas = canvas.resize((canvas.width * scale, canvas.height * scale), Image.NEAREST)
    canvas.save(path)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shots', required=True)
    ap.add_argument('--summary', required=True)
    ap.add_argument('--views', default='')
    ap.add_argument('--out', default='')
    ap.add_argument('--base-prefix', default='base-')
    ap.add_argument('--cand-prefix', default='cand-')
    a = ap.parse_args()

    summ = json.load(open(a.summary, encoding='utf-8'))
    proj = {v['view']: v.get('proj') for v in summ.get('views', [])}
    views = a.views.split(',') if a.views else [v['view'] for v in summ.get('views', [])]
    out_dir = a.out or a.shots

    report = {'views': []}
    for v in views:
        bp = os.path.join(a.shots, f'{a.base_prefix}{v}.png')
        cp = os.path.join(a.shots, f'{a.cand_prefix}{v}.png')
        if not (os.path.isfile(bp) and os.path.isfile(cp)):
            report['views'].append({'view': v, 'error': 'missing png'})
            continue
        base, cand = load(bp), load(cp)
        ds, dm, mask = diff_stats(base, cand)
        ds['view'] = v
        ds['near_white'] = near_white_stats(base, cand)

        tag = 'noise' if a.cand_prefix != 'cand-' else 'diff'
        save_heat(dm, os.path.join(out_dir, f'{tag}-{v}.png'))

        regions = []
        # 第 1 条：B 便利店平台接缝（林离测点）
        if v == 'art-b-konbini':
            regions.append(region_stats(base, cand, (552, 640, 612, 710), 'B平台接缝(x572-592,y660-690外扩20)'))
            save_crop_pair(base, cand, (532, 620, 632, 730), os.path.join(out_dir, 'crop-B-seam.png'))
        # 第 3 条：D 洗衣店门内
        if v == 'art-d-laundry':
            h, w, _ = base.shape
            regions.append(region_stats(base, cand, (int(w * 0.30), int(h * 0.30), int(w * 0.70), int(h * 0.75)), 'D洗衣店画面中部(门内)'))
            save_crop_pair(base, cand, (int(w * 0.25), int(h * 0.25), int(w * 0.75), int(h * 0.80)), os.path.join(out_dir, 'crop-D-indoor.png'))
        # 第 2 条：W1 投影点附近
        pj = proj.get(v)
        if pj and pj.get('px') and pj.get('inFront'):
            px, py = pj['px']
            if 0 <= px < base.shape[1] and 0 <= py < base.shape[0]:
                regions.append(region_stats(base, cand, (px - 80, py - 80, px + 80, py + 80), f'W1投影点({px},{py})±80'))
                save_crop_pair(base, cand, (px - 90, py - 90, px + 90, py + 90), os.path.join(out_dir, f'crop-W1-{v}.png'))
        ds['regions'] = regions
        report['views'].append(ds)

    out_json = os.path.join(out_dir, 'diff-report.json')
    with open(out_json, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    # 打印摘要
    print(f"{'view':<22}{'变化像素':>10}{'占比':>9}{'最大通道差':>10}{'近白新增':>9}")
    for r in report['views']:
        if r.get('error'):
            print(f"{r['view']:<22}{r['error']}")
            continue
        nw = r['near_white']['added_count']
        print(f"{r['view']:<22}{r['changed_pixels']:>10}{r['changed_ratio']*100:>8.3f}%{r['max_channel_diff']:>10}{nw:>9}")
    print('\n写出:', out_json)


if __name__ == '__main__':
    main()



