// Prepare the active CC0 building locally; historical city packages remain opt-in audits.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'city-assets.json'), 'utf8'));
const output = path.resolve(root, manifest.preparedRoot);
const usage = 'node scripts/prepare-city.cjs [--verify|--retired=<downtown|highrise>]';
const office = manifest.projects.kenneyCommercial;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function within(base, relative) {
  const resolved = path.resolve(base, relative), rel = path.relative(base, resolved);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Asset path escapes its root: ' + relative);
  return resolved;
}
function verifyOffice(directory = path.join(output, office.directory)) {
  const files = office.files.map(expected => {
    const file = within(directory, expected.path);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256) throw new Error('Pinned Kenney asset mismatch: ' + file);
    return { path: path.relative(root, file).replaceAll('\\', '/'), sha256: expected.sha256 };
  });
  return { project: 'kenneyCommercial', files };
}
function prepareOffice() {
  const directory = path.join(output, office.directory);
  if (fs.existsSync(directory)) return verifyOffice(directory);
  const archives = path.join(root, '.local', 'archives'), archive = path.join(archives, office.archive);
  fs.mkdirSync(archives, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const stage = fs.mkdtempSync(path.join(output, '.kenney-'));
  try {
    if (!fs.existsSync(archive)) {
      const args = ['--fail', '--location', '--silent', '--show-error', '--user-agent', 'AgentReviewRoom/1.0 (public asset preparation)', '--referer', office.source,
        ...(process.env.WORLD_BASE_PROXY ? ['--proxy', process.env.WORLD_BASE_PROXY] : [])];
      const reply = execFileSync('curl.exe', [...args, '-H', 'Accept: application/json', '-H', 'Sec-Fetch-Site: same-origin', office.downloadLink], { encoding: 'utf8', windowsHide: true });
      const signed = new URL(JSON.parse(reply).url);
      if (signed.origin !== new URL(office.source).origin) throw new Error('Unexpected Kenney download origin');
      const part = path.join(stage, 'archive.zip');
      execFileSync('curl.exe', [...args, signed.href, '-o', part], { windowsHide: true });
      if (digest(fs.readFileSync(part)) !== office.sha256) throw new Error('Kenney archive SHA-256 mismatch');
      try { fs.linkSync(part, archive); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (digest(fs.readFileSync(archive)) !== office.sha256) throw new Error('Pinned Kenney archive differs: ' + archive);
    const unpacked = path.join(stage, 'model');
    for (const file of office.files) {
      const dest = within(unpacked, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, execFileSync('tar.exe', ['-xOf', archive, file.entry], { windowsHide: true }));
    }
    verifyOffice(unpacked);
    try { fs.renameSync(unpacked, directory); }
    catch (error) { if (!fs.existsSync(directory)) throw error; }
    return verifyOffice(directory);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
function main() {
  const args = process.argv.slice(2);
  if (!args.length) { console.log(JSON.stringify(prepareOffice())); return; }
  if (args.length === 1 && args[0] === '--verify') { console.log(JSON.stringify(verifyOffice())); return; }
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
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
module.exports = { prepareOffice, verifyOffice };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
