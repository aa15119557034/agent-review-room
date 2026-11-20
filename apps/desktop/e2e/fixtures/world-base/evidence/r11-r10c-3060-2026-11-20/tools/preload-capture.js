// preload-capture.js
// 目的：让两次截图运行**完全可复现**，这样逐像素比对才有意义。
// 三件事：
//   1. 强制 preserveDrawingBuffer=true —— 否则合成后画布被清空，只能抓到黑图
//   2. 把 Math.random 换成固定种子的伪随机 —— 否则樱吹雪/草叶每次落点都不同
//   3. 把 requestAnimationFrame 的时间戳换成固定步长虚拟时钟 —— 否则两次跑的时间相位不同，风和水面动画全错位

// ---- 1. preserveDrawingBuffer ----
const origGetContext = HTMLCanvasElement.prototype.getContext
HTMLCanvasElement.prototype.getContext = function (type, attrs) {
  if (typeof type === 'string' && type.indexOf('webgl') === 0) {
    attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true })
  }
  return origGetContext.call(this, type, attrs)
}

// ---- 2. 确定性随机 ----
let __seed = 0x254  // 固定种子；改这个数会得到另一套落点，但只要两次相同即可
Math.random = function () {
  __seed = (__seed * 1664525 + 1013904223) >>> 0
  return __seed / 4294967296
}

// ---- 3. 确定性时钟 ----
const __raf = window.requestAnimationFrame.bind(window)
let __vtime = 1000  // 从 1000ms 起，避免 0 值引发除零之类的边界
window.requestAnimationFrame = function (cb) {
  return __raf(function () {
    __vtime += 1000 / 60
    cb(__vtime)
  })
}
// performance.now 也钉住，避免直接读它的逻辑漂移
performance.now = function () { return __vtime }

