// preload-freeze.js —— 时钟完全冻结（dt 恒为 0），用于确认动画相位是否是差异来源
const origGetContext = HTMLCanvasElement.prototype.getContext
HTMLCanvasElement.prototype.getContext = function (type, attrs) {
  if (typeof type === 'string' && type.indexOf('webgl') === 0) {
    attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true })
  }
  return origGetContext.call(this, type, attrs)
}
let __seed = 0x254
Math.random = function () { __seed = (__seed * 1664525 + 1013904223) >>> 0; return __seed / 4294967296 }
const __raf = window.requestAnimationFrame.bind(window)
const FIXED = 5000
window.requestAnimationFrame = function (cb) { return __raf(function () { cb(FIXED) }) }
performance.now = function () { return FIXED }
