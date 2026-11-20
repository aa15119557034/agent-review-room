# C11 只读源码 / CPU 审核

源码 e1f32af，比较83516e8。未改fixture、未运行GPU。实际运行 node x51-c11-city-shadow-driver.mjs，exit0；原始输出 x51-c11-city-shadow-result.json。真实GB/地形/材质工厂/GLTF几何，图像像素与canvas绘制为placeholder，不代表视觉验收。

四个Toon不投影分箱（最终city遍历后均cast=false、receive=true）：

| 分箱 | 三角形 | 实际组成 |
|---|---:|---|
| concrete |796|五基础60、五楼入口阶552、levee阶120、两杆身64|
| plain |564|五压顶60、横担24、绝缘子96、导线384|
| asphalt |708|两条连接路|
| plain/noOutline |565|十株花簇550、洗衣店盆花15|

所以“4个都是上游小部件”不准确。全部六组连接台阶失去cast；公寓背部钢楼梯、楼墙、阳台、低层房、crate、A-frame、盆体和植物主体最终仍cast/receive=true。总三角形28,857，未增几何。来源调用栈及范围保存在原始JSON。city资源归属代码未改；两次dispose观察到23个root几何/20个root材质释放，借用贴图释放0；这次未单独统计customDepthMaterial事件。

AO新公式：near(h)用(-.04,0)软门再乘(0,.48)衰减；h=-.02时near=.5，因此h<0一概不计的文字需限定为h<=-.04。rise<=.03m门槛为0，到.12m满值；角度门槛cos 0.06 至 0.25；L<=1.2m不衰减、到2m为0。系数1.4在正好8个满贡献tap时为70%遮蔽，并非全情况上限。

平面near因子确实消除旧式欧氏距离近处回升机制，但完整贡献仍乘rise/角度门与L截断，且采样所属表面会变化，不能仅凭h推导整幅图单调。实际效果交root固定机位GPU验收；本报告没有复用C10失败断言作为C11结果。

源码/driver/result SHA256与标量采样详见同名JSON。
