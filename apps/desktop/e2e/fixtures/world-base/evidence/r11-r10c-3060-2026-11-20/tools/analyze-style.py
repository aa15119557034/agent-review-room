#!/usr/bin/env python3
"""X-51 画风数值解析：把截图量化成可比对的一组数。

量的是"能不能写进 shader 的规格"，不是审美判断：
  亮度/对比  -> S 曲线的两端
  饱和度     -> 调色强度
  色阶档数   -> 是否已经量化成色块（赛璐璐化程度）
  边缘占比   -> 描边/线稿的密度
  近白/近黑  -> 高光溢出与黑位抬起

用法：python analyze-style.py <图片...> [--json out.json]
"""
import json
import sys
import os
import numpy as np
from PIL import Image


def analyze(path):
    im = Image.open(path).convert('RGB')
    a = np.asarray(im).astype(np.float32) / 255.0
    h, w, _ = a.shape

    # 亮度（Rec.709）
    lum = 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]

    # 饱和度（HSV 的 S，逐像素 max-min / max）
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)

    # 边缘强度（Sobel 近似：梯度幅值）
    gx = np.abs(np.diff(lum, axis=1, prepend=lum[:, :1]))
    gy = np.abs(np.diff(lum, axis=0, prepend=lum[:1, :]))
    edge = np.sqrt(gx ** 2 + gy ** 2)

    # 色阶档数：把亮度量化到 32 档，看有多少档占了 >0.5% 的像素
    bins = (lum * 32).astype(np.int32).clip(0, 31)
    hist = np.bincount(bins.ravel(), minlength=32).astype(np.float64)
    hist /= hist.sum()
    levels_used = int((hist > 0.005).sum())

    # 近白 / 近黑（对应验收里的"三通道 ≥250 的近白像素"）
    near_white = float((a.max(axis=2) * 255 >= 250).mean())
    near_black = float((a.max(axis=2) * 255 <= 10).mean())

    return {
        'file': os.path.basename(path),
        'size': [w, h],
        'lum_mean': round(float(lum.mean()), 4),
        'lum_p05': round(float(np.percentile(lum, 5)), 4),
        'lum_p95': round(float(np.percentile(lum, 95)), 4),
        'contrast_p05_p95': round(float(np.percentile(lum, 95) - np.percentile(lum, 5)), 4),
        'sat_mean': round(float(sat.mean()), 4),
        'sat_p95': round(float(np.percentile(sat, 95)), 4),
        'levels_used_32': levels_used,
        'edge_mean': round(float(edge.mean()), 4),
        'edge_ratio_gt_0.1': round(float((edge > 0.1).mean()), 4),
        'near_white_ratio': round(near_white, 5),
        'near_black_ratio': round(near_black, 5),
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    out = None
    if '--json' in sys.argv:
        out = sys.argv[sys.argv.index('--json') + 1]

    rows = []
    for p in args:
        if not os.path.isfile(p):
            print('SKIP', p, file=sys.stderr)
            continue
        rows.append(analyze(p))

    hdr = ['file', 'size', 'lum_mean', 'p05', 'p95', 'contrast', 'sat_mean', 'sat_p95', 'levels', 'edge', 'near_w', 'near_b']
    print('| ' + ' | '.join(hdr) + ' |')
    print('|' + '|'.join(['---'] * len(hdr)) + '|')
    for r in rows:
        print('| ' + ' | '.join([
            r['file'], f"{r['size'][0]}x{r['size'][1]}",
            f"{r['lum_mean']:.3f}", f"{r['lum_p05']:.3f}", f"{r['lum_p95']:.3f}",
            f"{r['contrast_p05_p95']:.3f}", f"{r['sat_mean']:.3f}", f"{r['sat_p95']:.3f}",
            str(r['levels_used_32']), f"{r['edge_mean']:.4f}",
            f"{r['near_white_ratio']*100:.2f}%", f"{r['near_black_ratio']*100:.2f}%",
        ]) + ' |')

    if out:
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(rows, f, ensure_ascii=False, indent=2)
        print('\n写出:', out, file=sys.stderr)


if __name__ == '__main__':
    main()
