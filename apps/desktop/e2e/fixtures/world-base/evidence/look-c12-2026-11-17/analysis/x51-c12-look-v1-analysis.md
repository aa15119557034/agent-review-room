# C12 固定时间真实素材回验

源：e38dd51a294da3a498b9404c0f27b854d16a2fd5。唯一 GPU 运行 session 75645／PID 60904，实际 exit1；GPU 已释放，不重试筛绿。目录：

`D:/codex/2026-11-16/world-implementation/world-base/apps/desktop/e2e/fixtures/world-base/artifacts/gpu-look-c12-v1`

7 机位×AO .55／0，各保存 warmup＋两帧，共42张原PNG及960宽JPG。相机直接使用C11已保存的capture-2，固定time14；所有14对相机、time、look参数一致。本轮不做96tap、阴影ABA、性能或碰撞复测。

## 实际状态

renderOk=true，transportClean=false。loading阶段 boulders.glb 与 plastic_crate_02.bin 两次 ERR_ABORTED 完整保留；无JS异常／HTTP错误。213项源清单与真实9资产清单均保存，source／driver／assets unchanged；恢复AO .55、contrast1.05、station-street／FOV58、时间及RAF，材质与投影标志未变。14组capture1／2 PNG字节一致。

## 本轮变化与保护对照

实际源清单相对C11仅 src/city.js、src/city-apartments.js 改变，look／shader未变。最终合成RGB逐像素对比不设“全部应相等”的前提：

| AO on 同机位 | 改变像素 | meanAbsRGB | 最大通道差 |
| --- | ---: | ---: | ---: |
| 23 service-corner | 0 | 0 | 0 |
| 24 laundry-details | 690601 | 5.368642 | 78 |
| 04 shop-interior | 0 | 0 | 0 |
| 20 rear-eye | 384630 | 1.514427 | 81 |
| 21 front-eye | 244244 | 1.178463 | 88 |
| 01 station-street | 464 | .000367798 | 7 |
| 旧C8服务角 | 42 | .000019805 | 2 |

01差异仅在x708..855／y360..391的远景区域；原图查看未见街道主体退化。20／21／24为有意材质变更，不能称全图不变。原尺寸查看范围、全部on/off数字见JSON。

## 材质与纹理实际读数

- 24(650,725)击中铺地顶面：station-local [6.14357,4.78481,-122.29891]，实际几何U/V约1.2m／周期，256²贴图repeat[1,1]、identity transform。这是整张纹理周期，不等于一块砖的尺寸。24铺地小ROI(590,780,70,40)由RGB均值[107.184,116.730,130.531]变为[74.374,80.111,88.629]；原图有砖缝与窄浅边，不再整面浅色平板。
- 24(1050,575)外墙、21(850,575)侧墙的真实三角UV均约1.5m／周期，repeat[1,1]，符合原3m周期减半。墙纹更密；这不意味着原grime环纹已变为全新材质。
- 独立店玻璃为ShaderMaterial，实际uOpacity=.08、uStreaks=0、DoubleSide、depthWrite=false；住宅玻璃仍.38／1。源码透明度还叠加Fresnel×.35，不能称固定92%透光。21(440,460,40,14)透玻璃合成ROI均值从[132.670,138.018,146.009]变[93.845,107.975,117.375]；机器后青墙与白机器出现区分，但这不是隔离墙色／透光率测量。
- 实际town总三角29109，C11为28857，增加252；ownedTextures=0、newTexturePixels=0。数据来自运行时stats，不是性能成本结论。

## C11 AO／暗部回归

shop-interior AO on和off各自对C11全图RGB差0。原后墙ROI x270..429/y280..329完整逐行数据保留；off−on红通道在y285/289/295/304/313/322为24.04375／17.325／11.25625／4.5／1.975／0，没有重现C10已定位的313次峰。这里用同图回归与未变shader证明该处保持，未重跑GPU tap，也不宣称全场景AO正确。

旧服务角两个12×18 HDR ROI的scene／comp半浮点字与C11、原C8一致；最终(763,369)=[26,31,42]，(762,459)=[26,31,41]，暗纹修补保持。当前23服务角本轮on/off都与C11各自RGB一致；卷帘、箱筐与地面纹理本轮未精修，不能因回归稳定而记成视觉任务完成。

## 共面薄边与限制

station代理冻结CPU审计 x51-c12-readonly-audit.json / x51-c12-city-result.json 指出：基础concrete与rim的垂直9cm侧面共面，顶面有.005m差。这是几何风险。21／24当前原尺寸固定图未看见明确花边；重复静止两帧完全相同，**不能排除移动相机时的z-fighting**，不将其降格为“已证明无问题”，也不从源级可能性推成已复现视觉失败。没有追加GPU或改几何。

原图、报告、源清单、资产清单以及外部驱动共96个文件SHA256见 x51-c12-look-v1-analysis.json.evidenceHashes；独立CPU共面证据hash另列coplanarSourceReference。离线复现：

```text
node D:/codex/2026-11-16/world-implementation/handoff/x51-c12-look-offline-analysis.cjs
```

已实际exit0；该驱动及GPU驱动node --check均exit0。只解码原PNG，不修改图片。射线只证明真实几何／UV，忽略fragment alpha／clip，不能单独证明最终片元身份。所有RGB为编码后合成字节，不是线性亮度。原始失败、图像与driver保持不覆盖。
