# 第 14 轮：街道立方体倒影重烘（主控机实跑）

C酱 交接里第 3 条要求在主控机跑 `node scripts/bake-street-reflections.cjs`。

## 命令

```powershell
Remove-Item env:ELECTRON_RUN_AS_NODE
node scripts/bake-street-reflections.cjs --electron=<electron.exe> --output=<out>
```

Electron 44.9.0，fixture HEAD `65da5342`。

## 结果：六面都烘出来了，但脚本判 ok=false

| 检查项 | 值 |
|---|---|
| `stage` | complete |
| `bakeValid` | **true** |
| `encodingValid` | **true** |
| 六面 sha256 | 全部产出（256×256，RGBA half-float 中间量 + PNG） |
| `glError` | 0 |
| `edgesMatch` | true |
| `restore.equal` | true（相机/时间/可见性都还原了） |
| **`transportClean`** | **false** |
| `ok` | **false** |
| `rangeUnclipped` | false（px/nx/pz/nz 各有 9–47 个像素超过 2.0，编码时按比例压到 ≤2） |

## 判 false 的原因

`transportClean: false` —— 烘焙期间有 4 个请求被取消（`net::ERR_ABORTED`，均 `canceled: true`）：

```
/assets/models/menhir.glb
/mature-sakura/mature-sakura.glb
/prop-assets/plastic_crate_02/plastic_crate_02_1k.gltf
/prop-assets/plastic_crate_02/plastic_crate_02.bin
```

看起来是烘焙流程临时隐藏/排除一批对象时，把它们正在进行的加载一并中止了。**面部数据本身是有效的**（六面都有 sha256、无 GL 错误、边缘对齐），但脚本的准入条件把它判成不可用。

## 所以我没有覆盖 src/street-env/

`src/street-env/` 和 `src/street-env-evening/` 保持原样。六面和报告都放在这个目录下，要不要采用由 C酱 定：

- 如果认为那 4 个取消是良性的（加载器的正常中止），可以直接把 `px/nx/py/ny/pz/nz.png` 拷进 `src/street-env-evening/`；
- 如果 `transportClean` 是必须有意义的守卫，那需要在烘焙流程里先等加载完成再隐藏对象，重跑一次。

## 另外两条（同批实测）

**加载耗时**：33.1 秒（离屏 Electron，1440×900，含素材解码与烘云）。云端软件渲染约 5 分钟，真机快约 9 倍。

**着色器告警**：没有编译失败，但有 D3D 的 X4000 告警（不是错误）：

```
(113,1): warning X4000: use of potentially uninitialized variable (f_skyBase)
(128,1): warning X4000: use of potentially uninitialized variable (f_skyBase)
(295,1) / (185,1) / (195,1) / (203,1) / (227,1) / (233,1) / (304,1)：同样是 f_skyBase
(573,1): warning X4000: use of potentially uninitialized variable (f_townMask)
(463,1) / (264,1): warning X4000: use of potentially uninitialized variable (f_townMaskV)
X3595: gradient instruction used in a loop with varying iteration（多处在 12-86 列范围）
X3577: value cannot be NaN, isnan() may not be necessary
```

`f_skyBase` / `f_townMask` / `f_townMaskV` 都是新增或改动的片元入口变量，编译器认为存在未初始化路径。目前出图正常，但这属于"某些驱动上可能出脏值"的隐患，建议在 r15 里给这几个变量一个显式初值。

**uniform 上限**：片元 1024 / 顶点 4095 / 贴图单元 16 —— 新增 8 个 vec4 远在安全范围，无风险。
