// Remove machine-specific handles but keep the original request/receipt relationships.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');

const [sceneFile, controlsFile, out] = process.argv.slice(2);
if (!out) throw Error('Usage: node archive.cjs <scene.json> <controls.json> <output directory>');
const fixture = path.resolve(__dirname, '../..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function archive(file, filename, sourceFiles) {
  const input = fs.readFileSync(file);
  const raw = JSON.parse(input);
  const receipts = new Map(), requests = new Map(), blobs = new Map();
  function alias(map, value, prefix) {
    if (!value) return value;
    if (!map.has(value)) map.set(value, prefix + (map.size + 1));
    return map.get(value);
  }
  function localURL(value) {
    if (!value || value.startsWith('/')) return value;
    const u = new URL(value);
    if (u.protocol === 'blob:') return alias(blobs, value, 'blob:fixture-');
    assert.equal(u.protocol, 'http:');
    assert.equal(u.hostname, '127.0.0.1');
    return u.pathname + u.search;
  }
  // Preallocate handles in encounter order, including both twins sharing the same URL.
  for (const item of raw.transport?.requests || raw.cases) {
    alias(requests, item.requestId, 'request-');
    alias(receipts, item.receipt, 'reply-');
  }
  const result = JSON.parse(JSON.stringify(raw, (key, value) => {
    if (key === 'requestId') return alias(requests, value, 'request-');
    if (key === 'receipt') return alias(receipts, value, 'reply-');
    if (key === 'url') return localURL(value);
    return value;
  }));
  result.rawCaptureSHA256 = digest(input);
  result.driverSHA256 = Object.fromEntries(sourceFiles.map(name =>
    [name, digest(fs.readFileSync(path.join(fixture, name)))]));
  const json = JSON.stringify(result, null, 2) + '\n';
  assert(!/[A-Za-z]:[\\/]|https?:\/\/|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i.test(json),
    'Host details require review before publishing this report');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out,filename),gzipSync(json,{level:9}));
}

const common = ['scripts/acceptance-transport.cjs','scripts/baseline.cjs'];
const here = path.relative(fixture,__dirname).split(path.sep).join('/');
archive(sceneFile,'normal-scene.json.gz',[...common,'scripts/check-fixture-transport.cjs']);
archive(controlsFile,'controls.json.gz',[...common,here+'/controls.cjs',here+'/client.cjs']);
