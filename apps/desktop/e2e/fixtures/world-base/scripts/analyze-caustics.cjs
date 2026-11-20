// CPU only. Run: node <script> <fixture-root> [report.json]
// Executes the exact pinned texture generator with a DataTexture data holder;
// does not import Three.js, create a renderer, or use a GPU.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fixture = path.resolve(process.argv[2] || process.cwd());
const file = path.join(fixture, 'upstream/petalwake/src/world/water.js');
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('export function makeWaveNormalTexture()');
const end = source.indexOf('export class Water', start);
if (start < 0 || end < 0) throw new Error('Pinned generator delimiters changed');
const generator = source.slice(start, end).replace('export ', '');
const THREE = { DataTexture: class {
  constructor(data, width, height) { this.image = { data, width, height }; }
} };
const texture = Function('THREE', generator + '; return makeWaveNormalTexture();')(THREE).image;
const count = texture.width * texture.height;
const histogram = [new Float64Array(256), new Float64Array(256)];
let data = new Float64Array(count * 2);
for (let i = 0; i < count; i++) for (let c = 0; c < 2; c++) {
  const value = texture.data[i * 4 + c + 2];
  histogram[c][value]++;
  data[i * 2 + c] = value / 255;
}
const caustic = (a, b) => Math.pow(Math.max(1 - Math.abs(a - b) * 2.2, 0), 5) * 1.6;
let independentTexelMean = 0;
for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
  independentTexelMean += histogram[0][a] * histogram[1][b] * caustic(a / 255, b / 255) / (count * count);
}
let seed = 73;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
function bilinear(u, v, channel, size, values) {
  const x = (u - Math.floor(u)) * size - .5, y = (v - Math.floor(v)) * size - .5;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const at = (x, y) => values[(((y + size) % size) * size + (x + size) % size) * 2 + channel];
  return (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy)
    + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
}
const samples = 250000, levels = [];
for (let size = texture.width; size >= 1; size /= 2) {
  let independent = 0, coupled = 0;
  for (let n = 0; n < samples; n++) {
    const u = random() * 100, v = random() * 100;
    independent += caustic(bilinear(u, v, 0, size, data), bilinear(random(), random(), 1, size, data));
    coupled += caustic(bilinear(u + .49, v, 0, size, data), bilinear(u * 1.37, v * 1.37 - .574, 1, size, data));
  }
  levels.push({ size, mip: Math.log2(texture.width / size), independentBilinear: independent / samples, coupledUVTime14: coupled / samples });
  if (size === 1) break;
  const nextSize = size / 2, next = new Float64Array(nextSize * nextSize * 2);
  for (let y = 0; y < nextSize; y++) for (let x = 0; x < nextSize; x++) for (let c = 0; c < 2; c++) {
    next[(y * nextSize + x) * 2 + c] = (data[(y * 2 * size + x * 2) * 2 + c]
      + data[(y * 2 * size + x * 2 + 1) * 2 + c]
      + data[((y * 2 + 1) * size + x * 2) * 2 + c]
      + data[((y * 2 + 1) * size + x * 2 + 1) * 2 + c]) / 4;
  }
  data = next;
}
const report = {
  method: 'Exact native generator executed with CPU-only DataTexture holder; no Three.js import or GPU',
  source: 'upstream/petalwake/src/world/water.js',
  sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  generatorSha256: crypto.createHash('sha256').update(generator).digest('hex'),
  samplesPerLevel: samples, randomSeed: 73,
  channelMeans: histogram.map(h => h.reduce((sum, n, value) => sum + n * value / 255 / count, 0)),
  independentTexelMean, levels,
  limitations: [
    'Histogram integral assumes independent B/A samples; bilinear estimate is Monte Carlo.',
    'Coupled sample uses shader scale 1.37, time14 offsets, and uniform UV over [0,100)^2; excludes spatially varying refraction normals.',
    'Mip levels use floating-point 2x2 box averaging and bilinear sampling at integer LOD; not driver quantization, trilinear, or anisotropic filtering.',
    '0.398 is an approximate unresolved spatial mean for this pinned generator, not an exact local pixel integral.'
  ]
};
const json = JSON.stringify(report, null, 2) + '\n';
if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), json);
process.stdout.write(json);
