// Pinned loose assets only. Preserve original bytes and refuse to overwrite bad local files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fixture = path.resolve(__dirname, '..');

function inside(base, file) {
  const rel = path.relative(base, file);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error(`Path escapes ${base}: ${file}`);
  return file;
}

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part))) throw new Error(`Invalid asset relative path: ${value}`);
  return value;
}

// Resolve the closest existing ancestor as well as the lexical path, including before mkdir/write.
function containedPath(base, relative) {
  const realBase = fs.realpathSync(base);
  const file = inside(path.resolve(base), path.resolve(base, relativePath(relative)));
  let ancestor = file;
  while (!fs.existsSync(ancestor)) {
    // A dangling symlink must not be followed later when writing.
    try { fs.lstatSync(ancestor); throw new Error(`Dangling asset path: ${ancestor}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    ancestor = path.dirname(ancestor);
  }
  inside(realBase, fs.realpathSync(ancestor));
  return file;
}

function readManifest(root = fixture) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'prop-assets.json'), 'utf8'));
  if (manifest.preparedRoot !== '.local/textured-props' || manifest.route !== '/prop-assets/' || manifest.userAgent !== 'agent-review-room-X51-asset-audit') throw new Error('Unexpected prop asset preparation root, route or User-Agent');
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Empty prop asset manifest');
  const seen = new Set();
  for (const file of manifest.files) {
    relativePath(file.path); relativePath(file.localSource);
    if (seen.has(file.path)) throw new Error(`Duplicate prop asset: ${file.path}`);
    seen.add(file.path);
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{32}$/.test(file.md5) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid size/hash: ${file.path}`);
    const url = new URL(file.sourceUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'dl.polyhaven.org' || url.username || url.password || url.port || url.search || url.hash || !url.pathname.startsWith('/file/ph-assets/')) throw new Error(`Non-official asset URL: ${file.sourceUrl}`);
  }
  if (manifest.totalBytes !== manifest.files.reduce((sum, file) => sum + file.bytes, 0)) throw new Error('Prop manifest totalBytes mismatch');
  return manifest;
}

function verifyFile(file, expected) {
  if (!fs.statSync(file).isFile()) throw new Error(`Asset is not a regular file: ${file}`);
  const bytes = fs.readFileSync(file);
  const actual = { bytes: bytes.length, md5: crypto.createHash('md5').update(bytes).digest('hex'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  for (const key of ['bytes', 'md5', 'sha256']) if (actual[key] !== expected[key]) throw new Error(`${expected.path}: ${key} mismatch; existing bytes preserved without overwriting`);
  return actual;
}

function verifyClosure(manifest, getFile) {
  const listed = new Set(manifest.files.map(file => file.path));
  const closures = [];
  for (const entry of manifest.files.filter(file => file.path.endsWith('.gltf'))) {
    const gltf = JSON.parse(fs.readFileSync(getFile(entry), 'utf8'));
    const dependencies = new Set();
    for (const item of [...(gltf.buffers || []), ...(gltf.images || [])]) {
      const uri = item.uri;
      if (typeof uri !== 'string' || uri.includes('?') || uri.includes('#') || uri.includes(':')) throw new Error(`${entry.path}: expected an external relative glTF dependency`);
      const decoded = decodeURIComponent(uri);
      relativePath(decoded);
      const dependency = path.posix.join(path.posix.dirname(entry.path), decoded);
      if (!listed.has(dependency)) throw new Error(`${entry.path}: unlisted dependency ${dependency}`);
      const dependencyEntry = manifest.files.find(file => file.path === dependency);
      if (!fs.statSync(getFile(dependencyEntry)).isFile()) throw new Error(`${entry.path}: missing dependency ${dependency}`);
      dependencies.add(dependency);
    }
    const originalFiles = manifest.files.filter(file => file.path.startsWith(path.posix.dirname(entry.path) + '/') && !file.supplemental).map(file => file.path);
    if (originalFiles.length !== dependencies.size + 1 || originalFiles.some(file => file !== entry.path && !dependencies.has(file))) throw new Error(`${entry.path}: original glTF dependency closure differs from the manifest`);
    closures.push({ path: entry.path, dependencies: [...dependencies].sort() });
  }
  return closures;
}

function verifyPreparedAssets(root = fixture) {
  const manifest = readManifest(root);
  const prepared = containedPath(root, manifest.preparedRoot);
  const getFile = entry => containedPath(prepared, entry.path);
  const files = manifest.files.map(entry => ({ path: `${manifest.preparedRoot}/${entry.path}`, sourceUrl: entry.sourceUrl, ...verifyFile(getFile(entry), entry) }));
  return { manifest: 'prop-assets.json', preparedRoot: manifest.preparedRoot, route: manifest.route, files, totalBytes: manifest.totalBytes, gltfDependencies: verifyClosure(manifest, getFile), verifiedBeforeLaunch: true };
}

function prepare({ root = fixture, source, download = false } = {}) {
  if (source && download) throw new Error('Choose --source or --download, not both');
  const manifest = readManifest(root);
  const prepared = containedPath(root, manifest.preparedRoot);
  const sourceRoot = source ? fs.realpathSync(path.resolve(source)) : null;
  // Validate every existing target (and every supplied source) before creating any asset file.
  for (const entry of manifest.files) {
    const target = containedPath(root, `${manifest.preparedRoot}/${entry.path}`);
    if (fs.existsSync(target)) verifyFile(target, entry);
    else if (!sourceRoot && !download) throw new Error(`Missing ${entry.path}; use --source=<textured-props directory> or --download`);
    if (sourceRoot) verifyFile(containedPath(sourceRoot, entry.localSource), entry);
  }
  if (sourceRoot) verifyClosure(manifest, entry => containedPath(sourceRoot, entry.localSource));
  fs.mkdirSync(prepared, { recursive: true });
  for (const entry of manifest.files) {
    const target = containedPath(prepared, entry.path);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const part = containedPath(prepared, `${entry.path}.part`);
    // A stale partial is preserved for inspection; never silently replace it.
    const fd = fs.openSync(part, 'wx'); fs.closeSync(fd);
    if (sourceRoot) fs.copyFileSync(containedPath(sourceRoot, entry.localSource), part);
    else {
      const proxy = process.env.WORLD_BASE_PROXY;
      const result = spawnSync('curl.exe', [...(proxy ? ['--proxy', proxy] : []), '--location', '--fail', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '120', '--user-agent', manifest.userAgent, entry.sourceUrl, '--output', part], { stdio: 'inherit', windowsHide: true });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${entry.path}: curl exited ${result.status}; partial preserved, not promoted`);
    }
    verifyFile(part, entry);
    // COPYFILE_EXCL also refuses a destination created while preparation was in progress.
    containedPath(prepared, entry.path);
    fs.copyFileSync(part, target, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(part);
  }
  return verifyPreparedAssets(root);
}

function main() {
  const options = {};
  for (const arg of process.argv.slice(2)) {
    if (arg === '--help') { console.log('node scripts/prepare-props.cjs [--source=<asset-candidates/textured-props> | --download]\nNo arguments: verify the existing local assets. Fixed official URLs, optional WORLD_BASE_PROXY, no installs or retries.'); return; }
    if (arg === '--download' && !options.download) options.download = true;
    else if (arg.startsWith('--source=') && !options.source && arg.length > 9) options.source = arg.slice(9);
    else throw new Error(`Unknown or duplicate option: ${arg}`);
  }
  const report = prepare(options);
  console.log(`${report.files.length} prop files verified: ${report.totalBytes} bytes, size + MD5 + SHA-256 + glTF closure; original bytes unchanged`);
}

module.exports = { readManifest, verifyPreparedAssets, prepare };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
