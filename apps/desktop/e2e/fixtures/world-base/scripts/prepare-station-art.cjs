// Prepare the project-owned Blender delivery from its versioned, offline archive.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { listZip, readZipEntry, extractZip } = require('./zip.cjs');

const fixture = path.resolve(__dirname, '..');
const source = 'assets/station-art';
const bundle = 'station-art-fixture.zip';
const lock = 'station-art.sha256';
const buildings = ['alley-workshop.glb', 'laundry-infill.glb', 'station-exchange.glb'];
const manifests = ['mature-sakura.json', 'station-art-assets.json'];
const requiredNotices = ['station-art-notices/THIRD-PARTY.md', 'station-art-notices/licenses/LICENSE-station-art.txt', 'station-art-notices/licenses/LICENSE-Sakuragaoka.txt'];
const treePath = '.local/mature-sakura/mature-sakura.glb';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function releasePath(root) {
  const pin = fs.readFileSync(path.join(root, source, lock), 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(pin)) throw new Error('Invalid station art release SHA-256');
  return path.join(root, '.local', 'station-art-releases', pin);
}

function readRelease(root) {
  const directory = releasePath(root), pin = path.basename(directory);
  const archive = path.join(root, source, bundle), archiveBytes = fs.readFileSync(archive);
  if (sha256(archiveBytes) !== pin) throw new Error('Station art archive differs from the release SHA-256');
  const entries = listZip(archive);
  const notices = entries.filter(file => /^station-art-notices\/(?:THIRD-PARTY\.md|licenses\/LICENSE-[\w-]+\.txt)$/.test(file));
  if (!requiredNotices.every(file => notices.includes(file))) throw new Error('Station art attribution or MIT notices missing');
  const metadata = new Map();
  for (const file of [...manifests, ...notices]) metadata.set(file, readZipEntry(archive, file));
  const tree = JSON.parse(metadata.get(manifests[0])), models = JSON.parse(metadata.get(manifests[1]));
  if (tree.file !== 'mature-sakura.glb' || Object.keys(models).sort().join(',') !== buildings.join(',')) {
    throw new Error('Unexpected models in the station art delivery');
  }
  const files = [
    { path: treePath, bytes: tree.bytes, sha256: tree.sha256 },
    ...buildings.map(name => ({ path: '.local/station-art/' + name, bytes: models[name].bytes, sha256: models[name].sha256 })),
    ...Array.from(metadata, ([file, bytes]) => ({ path: file, bytes: bytes.length, sha256: sha256(bytes) })),
  ];
  if (sha256(fs.readFileSync(archive)) !== pin) throw new Error('Station art release changed during preparation');
  return { archive, bytes: archiveBytes.length, directory, files, pin };
}

function verifyDirectory(directory, files) {
  for (const file of files) {
    const data = fs.readFileSync(path.join(directory, file.path));
    if (data.length !== file.bytes || sha256(data) !== file.sha256) throw new Error('Station art checksum mismatch: ' + file.path);
  }
}

function receipt(root, release) {
  const relative = path.relative(root, release.directory).split(path.sep).join('/');
  return {
    archive: source + '/' + bundle, sha256: release.pin, bytes: release.bytes,
    files: release.files.map(file => ({ ...file, path: relative + '/' + file.path })),
  };
}

function verifyStationArt(root = fixture) {
  const release = readRelease(root);
  verifyDirectory(release.directory, release.files);
  return receipt(root, release);
}

function prepareStationArt(root = fixture) {
  const release = readRelease(root);
  if (!fs.existsSync(release.directory)) {
    const cache = path.dirname(release.directory);
    fs.mkdirSync(cache, { recursive: true });
    const stage = fs.mkdtempSync(path.join(cache, '.prepare-'));
    try {
      extractZip(release.archive, stage, release.files.map(file => file.path));
      verifyDirectory(stage, release.files);
      try { fs.renameSync(stage, release.directory); }
      catch (error) {
        // A concurrent prepare can finish first. The winning directory is verified below.
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code) || !fs.existsSync(release.directory)) throw error;
      }
    } finally {
      if (path.dirname(path.resolve(stage)) !== path.resolve(cache)) throw new Error('Unexpected station art staging directory');
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  verifyDirectory(release.directory, release.files);
  return receipt(root, release);
}

module.exports = { prepareStationArt, verifyStationArt, releasePath };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--verify')) throw new Error('Use no arguments to prepare, or --verify to check the installed release');
  const result = args.length ? verifyStationArt() : prepareStationArt();
  console.log(`Station art ${result.sha256}: ${result.files.length} files verified`);
}
