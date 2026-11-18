# C28 着色器钩子与车站静态合批

原 C28 的材质 getter 每次返回一个新函数。车站只将仍使用默认绘画钩子的普通材质纳入图集和合批，并用函数引用识别它们。新 getter 使四个普通测试网格全部失去合批资格。修复后，getter 对同一材质和未变更的钩子返回同一函数；自定义樱冠钩子仍能单独保留。

| Git 输入 | 普通网格参与合批 | 生成合批数 | 图集 | 最终网格（含独立樱冠） |
| --- | ---: | ---: | --- | ---: |
| C27 `26aafc0` | 4/4 | 2 | 2 张纹理、1 页 | 3 |
| 原 C28 `880a02a` | 0/4 | 0 | 0 页 | 5 |
| 首次修复 `5672dcb` | 4/4 | 2 | 2 张纹理、1 页 | 3 |
| 完整修复 `ca10742` | 4/4 | 2 | 2 张纹理、1 页 | 3 |
| 清晰度最终源 `b4f1350` | 4/4 | 2 | 2 张纹理、1 页 | 3 |

在本目录使用 Node.js 24.19.0 分别运行以下命令。五个进程均退出 0，包含对历史故障的预期断言。脚本直接从表中对应的 Git 对象加载 Three.js、`createMaterials`、`createSakuraMaterials`、`foliageMaterial`、`batchStatic` 和当版钩子，无须切换检出或启动场景。

```bat
node verify-batching.mjs upstream
node verify-batching.mjs raw
node verify-batching.mjs stable
node verify-batching.mjs fixed
node verify-batching.mjs final
```

每组有两块纯色普通材质、两块分别使用 4×4 色块纹理的普通材质和一个自定义樱冠材质。CPU canvas 提供图集所需的平面色块读写，实际的合批、UV 重映射与几何合并由项目代码执行。断言同时检查两种纹理颜色均已写入图集、替换自定义钩子后能调用新函数、默认程序缓存键能区分两个钩子、原始绘画参数保留。修复版还检查樱冠团块与花卡均有遮罩定义，共用的分档与轮廓光 uniform 能关、开。该最小样例只测逻辑，整站渲染耗时须以原生运行记录为准。

原生加载还依赖 `foliageMaterial` 对前一个钩子的裸调用。首次修复在这段真实生成代码中仍抛出 `Cannot read properties of undefined (reading 'name')`；完整修复能保留该材质的绘画参数 0.03。原 C28 把樱冠的包装钩子赋给普通材质克隆后，会错误沿用原樱冠名称并加上遮罩。完整修复在克隆上直接或摘出调用均采用克隆的名称，显式指定原樱冠接收者时也能正确标记。

[复跑脚本](verify-batching.mjs) · [C27 输出](upstream.json) · [原 C28 输出](raw.json) · [首次修复输出](stable.json) · [完整修复输出](fixed.json) · [清晰度最终源输出](final.json)
