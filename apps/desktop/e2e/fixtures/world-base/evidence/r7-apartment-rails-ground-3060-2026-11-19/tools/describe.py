"""Generate the human-readable comparison from measured data."""
import json
from pathlib import Path
archive=Path(__file__).resolve().parents[1]
s=json.loads((archive/'summary.json').read_text())
v=json.loads((archive/'visual-summary.json').read_text())
keys=list(v['views'])
labels=['A 站前主街','B 便利店','C 公寓后巷','D 洗衣店','E 港镇码头','F 东部山坡','G 铁路边','H 北村']
def table(cols,rows):
    return '\n'.join('| '+' | '.join(map(str,r))+' |' for r in [cols,['---']*len(cols),*rows])
def links(group,k):
    return f'[改前]({group}/before/{k}.png) · [改后]({group}/after/{k}.png)'
def metric(x): return f"{x['fps']:.2f} / {x['p95Ms']:.1f}"
def n(x): return f'{x:,}'
def triples(x): return ' / '.join(f'{k:.1f}' for k in x)
def paired(x): return ' → '.join(triples(v['railSamples'][arm][x]) for arm in ['before','after'])
rail=v['railSamples']
content=['# 第七轮洗衣店二楼栏杆验收','基线 `'+s['sources']['before']+'`，C酱候选 `'+s['sources']['after']+'`。实测使用 RTX 3060 Laptop、1440 × 900。所有对照均左改前、右改后。',
'两次运行接收的 4 个 GLB 和 9 张公寓纹理逐一同哈希，运行回执中 10 张海报、14 张贴纸、2 处涂鸦的布局指纹也一致。[资源哈希及运行材质](summary.json)',
'## D 洗衣店','![洗衣店二楼两跨栏杆原像素裁切](d-railings.jpg)',
f"复用第六轮同眼位下通过射线确认落在公寓漆钢上的 34 个采样位置，比较本轮两张独立截图。{rail['changed']}/34 点发生变化。下表给出显示亮度的第 10、50、90 百分位（0–255）。每个点的局部对比取其亮度与同一行左右各 5 像素处平均亮度的绝对差。",
table(['项目','改前 P10 / P50 / P90','改后 P10 / P50 / P90'],[[title,triples(rail['before'][item]),triples(rail['after'][item])] for item,title in [('lumaP10P50P90','栏杆位置'),('neighborLumaP10P50P90','两侧邻域'),('absLocalContrastP10P50P90','局部对比')]]),
'[逐点坐标与亮度](visual-summary.json) · [历史几何归属采样位置](tools/rail-reference.json)',
'两跨细杆靠近反光窗的位置仍能看清深色轮廓，亮度上升后与窗面的对比减弱。招牌字区、店门区两个对照框的单通道最大变化均为 1 级。',
'## C 后巷和地面八机位','![后巷钢梯与围网原像素裁切](c-stairs.jpg)',
'三处踏板采样框的显示亮度中位数维持在 67.82、88.83、93.62，近处围网立柱维持在 64.62。图中踏板间隙、右侧菱形网和后方暖灯仍可辨认。',
'![A 至 D](ground-a-d.jpg)','![E 至 H](ground-e-h.jpg)',
'同一基线提交在第六轮和第七轮各复拍一次，A、B、C、D、F、G、H 的 RGB 完全一致，可直接使用 D 的历史采样坐标。E 港口同提交已有 3,930 个像素发生变化，两版 E 的 5,533 个差异像素包含独立启动间的波动。[同提交复拍对照](baseline-recapture.json)',
'以下计数按 8 位 RGB 最大单通道差值计算。',
table(['机位','改变像素','差值 > 2 的像素','最大差值','原始 PNG'],[[label,n(v['views'][k]['changed']),n(v['views'][k]['over2']),v['views'][k]['max'],links('photos',k)] for label,k in zip(labels,keys)]),
'## 帧时','四次独立启动顺序为改前、改后、改后、改前。每个固定机位至少 10 秒，两种实际 W 步行各至少 3 秒。表内为平均 FPS / P95 毫秒。均值至少 60 FPS 且 P95 至多 16.7 ms 同时满足才计为达标。P95 用最近秩计算。',
table(['机位','改前 1','改后 1','改后 2','改前 2'],[[label]+[metric(t['segments'][k]) for t in s['timing']] for label,k in zip(labels+['第三人称步行','第一人称步行'],keys+['walk-third','walk-first'])]),
'固定机位达标数依次为 '+ '、'.join(str(sum(t['segments'][k]['pass'] for k in keys))+'/8' for t in s['timing'])+'。总计 '+n(sum(m['frames'] for t in s['timing'] for m in t['segments'].values()))+' 个帧间隔。每个采样条目保留原始毫秒、绘制调用和三角面数。',
'四次达标的机位都是 C、D、F、H。D 的四个 P95 均为 15.5 毫秒；G 在第二次候选运行达到 46.2 毫秒，其余三次均在 30.8–30.9 毫秒。两种步行四轮均未达到帧时门槛。',
' · '.join(f"[{name}逐帧]({t['tag']}/frames.json.gz)" for name,t in zip(['改前 1','改后 1','改后 2','改前 2'],s['timing'])),
'共尝试五次帧时采集。第四次是末轮基线的首次尝试，B 开始出现约 1 秒的 RAF 间隔，C–H 每个机位都只有 10 个约 1 秒的间隔。两种步行各仅 3 帧，可信 W 已按下，位移均小于 1 米，实走验证失败，进程退出码为 1。表中末列取相同条件的第五次完整重试。失败进程的八个固定机位、两段实走、输入和位移回执单独保留。[失败轮次逐帧与运行回执](excluded/r7-native-1119-5-before)',
'## 五个历史机位','![历史机位对照](legacy-comparison.jpg)',
table(['机位','改前 FPS / P95','改后 FPS / P95','改变像素','两份原图'],[[k,metric(s['legacy']['before'][k]),metric(s['legacy']['after'][k]),n(v['historical'][k]['changed']),links('legacy',k)] for k in s['legacy']['before']]),
'每个历史机位每版至少 6.5 秒。[改前逐帧](legacy/before/legacy-frames.json.gz) · [改后逐帧](legacy/after/legacy-frames.json.gz)',
'## 核验与复算','[全结果 JSON](summary.json) · [图片差异与裁切坐标](visual-summary.json) · [采集脚本及机位](tools) · [照片运行回执](receipts)',
'重新采集时，分别检出首段两版提交，另检出网络审计工具提交 `0db21d2df3ed097d4f3414539b92e8eadcc12b75`。下面三个 fixture 参数均指向各检出的 `apps/desktop/e2e/fixtures/world-base`，使用 Electron 44.9.0 和 RTX 3060 Laptop。在空采集目录中复制 tools 内的 CJS、cameras.json 和 sources.json 后运行；采集器顺序启动八个进程。',
'```text\nnode measure-ground.cjs <基线fixture> <候选fixture> <审计fixture> <electron.exe> r7-native-repeat\n```',
'归档单独下载后，在本目录执行 `python tools/verify.py` 可核验 28 张原始 PNG（含两张返回 A 检查图）与四轮逐帧数据。执行 `python tools/compare.py` 可从归档里的原图重建对照图和差异统计。',
'完整重新打包依赖 Python 3、NumPy、Pillow 和系统字体微软雅黑。在带有原始 photos-before/after、legacy-before/after、cameras.json 和 running-state.json 的采集目录上执行以下命令。帧时原件按 running-state.json 中的 fixture 与 id 定位。处理脚本输出到 tools 的上级目录。',
'```text\npython tools/compare.py <采集目录>\npython tools/archive.py <采集目录>\npython tools/describe.py\n```']
(archive/'README.md').write_text('\n\n'.join(content)+'\n',encoding='utf-8')
