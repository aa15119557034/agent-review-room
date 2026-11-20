# 修正：`?shadow=static` 之前不是真·只渲一次

C酱 在 #268 复审里指出（🟡 不挡合入）：`shadowEvery` 默认 30，所以 `?shadow=static` 实际也每 30 帧重渲。

## 原因

```js
const shadowStatic = shadowMode === 'static';
const shadowEvery = shadowMode === 'dynamic' ? 0 : Math.max(1, Number(?? 30) | 0);
//                                                                        ^^^ static 也拿到了 30
```

## 修法

```js
const shadowEvery = (shadowStatic || shadowMode === 'dynamic')
  ? 0
  : Math.max(1, Number(shadowQuery.get('shadowEvery') ?? 30) | 0);
```

## 实测验证（数 90 帧里每帧的绘制调用）

| 模式 | 调用数范围 | 出现阴影 pass 的帧数 |
|---|---|---|
| 默认（every30） | 1079 ~ 1645 | **3 / 90**（≈ 每 30 帧一次） |
| `?shadow=static` | 1079（恒定） | **0 / 90** ← 真·只渲一次 |
| `?shadow=dynamic` | 1645（恒定） | 每帧（基线值即高值） |

三种模式行为都正确。默认路径与修前逐像素一致（0.000%）。

工具：`x51-shadowcount.cjs`（采样每帧 `renderer.info.render.calls`，用"高于最小值 100 次"判定是否发生了阴影 pass）。
