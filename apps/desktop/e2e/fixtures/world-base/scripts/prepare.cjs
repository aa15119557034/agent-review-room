// Download pinned upstream originals to ignored .local; never overwrite edited vendored code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { prepareStationArt } = require('./prepare-station-art.cjs');
const { extractZip } = require('./zip.cjs');
const root = path.resolve(__dirname, '..');
const sources = JSON.parse(fs.readFileSync(path.join(root, 'sources.json'), 'utf8'));
const manifest = path.join(root, 'source-files.json');
const expected = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : null;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(exe, args) {
  const result = spawnSync(exe, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${exe} exited ${result.status}`);
}
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const file = path.join(dir, e.name);
    return e.isDirectory() ? files(file) : [file];
  });
}
const archives = path.join(root, '.local', 'archives');
fs.mkdirSync(archives, { recursive: true });
const inventory = [];
for (const name of ['petalwake', 'sakuragaoka']) {
  const source = sources[name];
  const zip = path.join(archives, `${name}.zip`);
  if (!fs.existsSync(zip)) {
    const part = `${zip}.part`;
    const proxy = process.env.WORLD_BASE_PROXY;
    run(process.platform === 'win32' ? 'curl.exe' : 'curl', [...(proxy ? ['--proxy', proxy] : []), '-L', '--fail', '--show-error', source.archive, '-o', part]);
    if (hash(part) !== source.sha256) throw new Error(`${name}: archive SHA-256 mismatch; not extracted`);
    fs.renameSync(part, zip);
  }
  if (hash(zip) !== source.sha256) throw new Error(`${name}: archive SHA-256 mismatch; not extracted`);
  const original = path.join(root, '.local', `${name}-${source.commit}`);
  if (!fs.existsSync(path.join(original, 'LICENSE'))) extractZip(zip, path.join(root, '.local'));
  const projectFiles = [];
  for (const file of files(original)) {
    // The evening bake writes its generated shadow map next to the upstream light map.
    if (name === 'petalwake' && file === path.join(original, 'assets', 'terrain', 'light-evening.png')) continue;
    projectFiles.push({ project: name, path: path.relative(original, file).replaceAll('\\', '/'), sha256: hash(file) });
  }
  if (expected) {
    const reference = new Map(expected.filter(file => file.project === name).map(file => [file.path, file.sha256]));
    if (projectFiles.length !== reference.size) throw new Error(`${name}: original copy is incomplete or contains extra files; restore the pinned archive before continuing`);
    for (const file of projectFiles) {
      if (reference.get(file.path) !== file.sha256) throw new Error(`${name}/${file.path}: local original differs from the pinned manifest; preserved without overwriting`);
    }
  }
  inventory.push(...projectFiles);
  console.log(`${name}: ${source.commit} archive and ${projectFiles.length} original files verified`);
  if (process.argv.includes('--vendor-code')) {
    const dest = path.join(root, 'upstream', name);
    if (fs.existsSync(dest)) throw new Error(`${dest} already exists; refusing to overwrite code which may have been refined`);
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of ['src', 'LICENSE', ...(name === 'petalwake' ? ['vendor'] : [])]) {
      fs.cpSync(path.join(original, entry), path.join(dest, entry), { recursive: true, errorOnExist: true, force: false });
    }
  }
}
// Hashes identify individual files; all upstream originals and binary assets stay local.
if (!expected) fs.writeFileSync(manifest, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`${inventory.length} upstream files inventoried; no assets copied into tracked source`);
const stationArt = prepareStationArt(root);
console.log(`Station art ${stationArt.sha256}: ${stationArt.files.length} files verified`);
