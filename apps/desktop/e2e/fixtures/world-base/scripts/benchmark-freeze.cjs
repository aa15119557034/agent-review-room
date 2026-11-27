'use strict';

const getContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (type, attributes) {
  if (typeof type === 'string' && type.startsWith('webgl')) {
    attributes = { ...attributes, preserveDrawingBuffer: true };
  }
  return getContext.call(this, type, attributes);
};

let seed = 0x254;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const nextFrame = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = callback => nextFrame(() => callback(5000));
performance.now = () => 5000;
