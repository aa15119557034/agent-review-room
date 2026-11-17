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
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'apartment-assets.json'), 'utf8'));
  if (manifest.preparedRoot !== '.local/apartment-surfaces' || manifest.route !== '/apartment-assets/' || manifest.userAgent !== 'agent-review-room-X51-asset-audit') throw new Error('Unexpected apartment asset preparation root, route or User-Agent');
  if (!Array.isArray(manifest.files) || manifest.files.length !== 9) throw new Error('Expected nine pinned apartment images');
  if (JSON.stringify(manifest.assets.map(asset => asset.id).sort()) !== JSON.stringify(['rectangular_facade_tiles', 'white_plaster_02', 'worn_shutter'])) throw new Error('Unexpected apartment surface set');
  const seen = new Set();
  for (const file of manifest.files) {
    relativePath(file.path); relativePath(file.localSource);
    if (file.width !== 1024 || file.height !== 1024 || !file.path.endsWith('.jpg')) throw new Error(`Expected original 1K JPEG: ${file.path}`);
    if (seen.has(file.path)) throw new Error(`Duplicate apartment asset: ${file.path}`);
    seen.add(file.path);
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{32}$/.test(file.md5) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid size/hash: ${file.path}`);
    const url = new URL(file.sourceUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'dl.polyhaven.org' || url.username || url.password || url.port || url.search || url.hash || !url.pathname.startsWith('/file/ph-assets/')) throw new Error(`Non-official asset URL: ${file.sourceUrl}`);
  }
  if (manifest.totalBytes !== manifest.files.reduce((sum, file) => sum + file.bytes, 0)) throw new Error('Apartment manifest totalBytes mismatch');
  return manifest;
}

function verifyFile(file, expected) {
  if (!fs.statSync(file).isFile()) throw new Error(`Asset is not a regular file: ${file}`);
  const bytes = fs.readFileSync(file);
  const actual = { bytes: bytes.length, md5: crypto.createHash('md5').update(bytes).digest('hex'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  for (const key of ['bytes', 'md5', 'sha256']) if (actual[key] !== expected[key]) throw new Error(`${expected.path}: ${key} mismatch; existing bytes preserved without overwriting`);
  return actual;
}

function jpegSize(bytes, file) {
  if(bytes[0]!==255||bytes[1]!==216)throw Error('Not JPEG: '+file.path);
  let p=2;
  while(p<bytes.length){
    if(bytes[p++]!==255)throw Error('Bad JPEG marker');while(bytes[p]===255)p++;
    const marker=bytes[p++];if(marker===217||marker===218)break;
    const len=bytes.readUInt16BE(p);if(len<2||p+len>bytes.length)throw Error('Bad JPEG segment');
    if([192,193,194].includes(marker)){
      const width=bytes.readUInt16BE(p+5),height=bytes.readUInt16BE(p+3);
      if(width!==file.width||height!==file.height)throw Error('JPEG dimensions mismatch: '+file.path);
      return {width,height};
    }p+=len;
  }throw Error('Missing JPEG dimensions: '+file.path);
}
function verifyClosure(manifest, getFile) {
  for(const id of manifest.assets.map(a=>a.id)) {
    const entries=manifest.files.filter(f=>f.id===id);
    if(entries.length!==3||JSON.stringify(entries.map(f=>f.semantic).sort())!==JSON.stringify(['baseColor','normalGL','occlusionRoughnessMetallic']))throw Error('Expected diffuse + GL normal + ARM for '+id);
  }
  return manifest.files.map(f=>({path:f.path,semantic:f.semantic,dimensions:jpegSize(fs.readFileSync(getFile(f)),f)}));
}

function verifyPreparedAssets(root = fixture) {
  const manifest = readManifest(root);
  const prepared = containedPath(root, manifest.preparedRoot);
  const getFile = entry => containedPath(prepared, entry.path);
  const files = manifest.files.map(entry => ({ path: `${manifest.preparedRoot}/${entry.path}`, sourceUrl: entry.sourceUrl, ...verifyFile(getFile(entry), entry) }));
  return { manifest: 'apartment-assets.json', preparedRoot: manifest.preparedRoot, route: manifest.route, files, totalBytes: manifest.totalBytes, textureDependencies: verifyClosure(manifest, getFile), verifiedBeforeLaunch: true };
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
    else if (!sourceRoot && !download) throw new Error(`Missing ${entry.path}; use --source=<apartment-surfaces directory> or --download`);
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
    if (arg === '--help') { console.log('node scripts/prepare-apartments.cjs [--source=<asset-candidates/apartment-surfaces> | --download]\nNo arguments: verify the existing local assets. Fixed official URLs, optional WORLD_BASE_PROXY, no installs or retries.'); return; }
    if (arg === '--download' && !options.download) options.download = true;
    else if (arg.startsWith('--source=') && !options.source && arg.length > 9) options.source = arg.slice(9);
    else throw new Error(`Unknown or duplicate option: ${arg}`);
  }
  const report = prepare(options);
  console.log(`${report.files.length} apartment files verified: ${report.totalBytes} bytes, size + MD5 + SHA-256 + texture closure + JPEG dimensions; original bytes unchanged`);
}

module.exports = { readManifest, verifyPreparedAssets, prepare };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
