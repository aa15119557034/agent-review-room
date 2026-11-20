// Download pinned upstream originals to ignored .local; never overwrite edited vendored code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { prepareStationArt } = require('./prepare-station-art.cjs');
const { extractZip } = require('./zip.cjs');
const root = path.resolve(__dirname, '..');
const sources = JSON.parse(fs.readFileSync(path.join(root, 'sources.json'), 'utf8'));
const manifest = path.join(root, 'source-files.json');
const expected = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : null;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function files(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (dir === base && e.name === '.git') return [];
    const file = path.join(dir, e.name);
    return e.isDirectory() ? files(file, base) : [file];
  });
}
const archives = path.join(root, '.local', 'archives');
fs.mkdirSync(archives, { recursive: true });

function inventoryAt(name, original, pinned = expected?.filter(file => file.project === name)) {
  const projectFiles = [];
  for (const file of files(original)) {
    // The evening bake writes its generated shadow map next to the upstream light map.
    if (name === 'petalwake' && file === path.join(original, 'assets', 'terrain', 'light-evening.png')) continue;
    projectFiles.push({ project: name, path: path.relative(original, file).replaceAll('\\', '/'), sha256: hash(file) });
  }
  if (pinned) {
    const reference = new Map(pinned.map(file => [file.path, file.sha256]));
    if (projectFiles.length !== reference.size) throw new Error(`${name}: original copy is incomplete or contains extra files; restore the pinned archive before continuing`);
    for (const file of projectFiles) {
      if (reference.get(file.path) !== file.sha256) throw new Error(`${name}/${file.path}: local original differs from the pinned manifest; preserved without overwriting`);
    }
  }
  return projectFiles;
}

function fetchArchive(name, source, stage, cached) {
  const download = path.join(stage, 'original.zip');
  const proxy = process.env.WORLD_BASE_PROXY;
  const curl = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', [
    ...(proxy ? ['--proxy', proxy] : []), '--location', '--fail', '--silent', '--show-error',
    '--write-out', '%{http_code}', '--output', download, source.archive,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  if (curl.error) throw curl.error;
  if (curl.status === 0) {
    if (hash(download) !== source.sha256) throw new Error(`${name}: archive SHA-256 mismatch; not extracted`);
    try {
      fs.renameSync(download, cached);
    } catch (error) {
      if (!fs.existsSync(cached)) throw error;
      if (hash(cached) !== source.sha256) throw new Error(`${name}: concurrently cached archive differs`);
    }
    return cached;
  }

  const httpStatus = curl.stdout.trim();
  if (httpStatus !== '403' || !expected) {
    throw new Error(`${name}: archive download exited ${curl.status} (HTTP ${httpStatus})`);
  }
  console.log(`${name}: archive HTTP 403; fetching pinned Git commit ${source.commit}`);
  const bare = path.join(stage, 'objects.git');
  const git = (...args) => execFileSync('git', [
    '-c', 'core.autocrlf=false', '-c', 'core.eol=lf',
    ...(proxy ? ['-c', 'http.proxy=' + proxy] : []), ...args,
  ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  git('init', '--quiet', '--bare', bare);
  git('--git-dir', bare, 'fetch', '--quiet', '--no-tags', '--depth=1', source.repository, source.commit);
  if (git('--git-dir', bare, 'rev-parse', 'FETCH_HEAD').trim() !== source.commit) {
    throw new Error(`${name}: Git returned a different commit`);
  }
  const archive = path.join(stage, 'from-git.zip');
  git('--git-dir', bare, 'archive', '--format=zip', '--prefix=' + name + '-' + source.commit + '/',
    '--output=' + archive, source.commit);
  return archive;
}

function prepareOriginal(name, source, original) {
  const cached = path.join(archives, name + '.zip');
  const hasArchive = fs.existsSync(cached);
  if (hasArchive && hash(cached) !== source.sha256) throw new Error(`${name}: cached archive SHA-256 mismatch; not extracted`);
  if (expected && fs.existsSync(original)) return inventoryAt(name, original);
  const stage = fs.mkdtempSync(path.join(archives, name + '-'));
  try {
    const zip = hasArchive ? cached : fetchArchive(name, source, stage, cached);
    extractZip(zip, stage);
    const extracted = path.join(stage, path.basename(original));
    const entries = inventoryAt(name, extracted);
    if (fs.existsSync(original)) return inventoryAt(name, original, entries);
    try {
      fs.renameSync(extracted, original);
    } catch (error) {
      if (!fs.existsSync(original)) throw error;
      return inventoryAt(name, original, entries);
    }
    return entries;
  } finally {
    if (path.dirname(path.resolve(stage)) === archives) fs.rmSync(stage, { recursive: true, force: true });
  }
}

const inventory = [];
for (const name of ['petalwake', 'sakuragaoka']) {
  const source = sources[name];
  if (!/^[0-9a-f]{40}$/.test(source.commit)) throw new Error(`${name}: invalid pinned commit`);
  const original = path.join(root, '.local', name + '-' + source.commit);
  const projectFiles = prepareOriginal(name, source, original);
  inventory.push(...projectFiles);
  console.log(`${name}: ${source.commit} and ${projectFiles.length} original files verified`);
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
