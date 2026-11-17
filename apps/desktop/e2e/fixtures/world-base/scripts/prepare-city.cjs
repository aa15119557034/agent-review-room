// Historical asset audit only. Current generated city requires no external city package.
// No copies, downloads, conversion, installation or renderer; prior local evidence stays untouched.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'city-assets.json'), 'utf8'));
const output = path.resolve(root, manifest.preparedRoot);
const usage = 'node scripts/prepare-city.cjs --retired=<downtown|highrise>\nRead-only SHA-256 and glTF dependency-closure audit of an explicitly selected historical package in .local/city.\nCurrent city needs no external assets. This tool does not prepare or copy files; old acquisition instructions are historical.';
function within(base, relative) {
  const resolved = path.resolve(base, relative), rel = path.relative(base, resolved);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Asset path escapes its root: ' + relative);
  return resolved;
}
function main() {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && args[0] === '--help')) { console.log(usage); return; }
  const match = args.length === 1 && /^--retired=([a-z]+)$/.exec(args[0]);
  if (!match || !Object.hasOwn(manifest.retiredAssets, match[1])) throw new Error('Select one known retired package explicitly.\n' + usage);
  const name = match[1], project = manifest.retiredAssets[name];
  const plan = project.files.map(expected => ({ expected, file: within(output, expected.destination) }));
  const destinations = new Set(plan.map(item => item.file));
  for (const { expected, file } of plan) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size !== expected.bytes || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected.sha256) {
      throw new Error('Pinned historical asset mismatch: ' + file + '; all files were preserved.');
    }
  }
  let references = 0;
  for (const { file } of plan) {
    if (!file.endsWith('.gltf')) continue;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const item of [...(json.buffers || []), ...(json.images || [])]) {
      if (!item.uri) continue;
      if (/^(?:[a-z]+:|\/|\\)/i.test(item.uri)) throw new Error('Unexpected non-local dependency in ' + file + ': ' + item.uri);
      const target = within(path.dirname(file), decodeURIComponent(item.uri));
      if (!destinations.has(target)) throw new Error('Historical dependency omitted from pinned list: ' + item.uri + ' (' + file + ')');
      references++;
    }
  }
  console.log(JSON.stringify({ purpose: 'historical-read-only-audit', package: name, verifiedFiles: plan.length, verifiedReferences: references, runtimeDependency: false, modifiedFiles: 0 }));
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
