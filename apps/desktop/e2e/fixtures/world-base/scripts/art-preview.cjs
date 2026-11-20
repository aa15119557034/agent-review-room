'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createStaticServer } = require('./baseline.cjs');
const props = require('./prepare-props.cjs');
const apartments = require('./prepare-apartments.cjs');
const { verifyStationArt } = require('./prepare-station-art.cjs');

const root = path.resolve(__dirname, '..');
const sources = JSON.parse(fs.readFileSync(path.join(root, 'sources.json'), 'utf8'));
const evening = JSON.parse(fs.readFileSync(path.join(root, 'src/evening.json'), 'utf8'));
const upstream = path.join(root, '.local', 'petalwake-' + sources.petalwake.commit);
const light = path.join(upstream, 'assets', evening.lightMap);
const [command = 'serve', portInput] = process.argv.slice(2);
if (!['serve', 'prepare', 'verify'].includes(command) || process.argv.length > (command === 'serve' ? 4 : 3)) {
  throw new Error('Usage: node scripts/art-preview.cjs prepare | verify | serve [port]');
}

if (command === 'prepare') {
  execFileSync(process.execPath, [path.join(__dirname, 'prepare.cjs')], {cwd:root, stdio:'inherit', windowsHide:true});
  const source = path.join(root, 'assets/art-preview');
  props.prepare({root, source});
  apartments.prepare({root, source});
  const python = process.env.WORLD_PREVIEW_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  execFileSync(python, [path.join(__dirname, 'bake-evening-light.py'), upstream], {
    cwd:root, stdio:'inherit', windowsHide:true,
    env:{...process.env, PYTHONDONTWRITEBYTECODE:'1', NUMBA_CACHE_DIR:path.join(root,'.local','art-preview-numba-cache')},
  });
}

const release = verifyStationArt(root);
const propFiles = props.verifyPreparedAssets(root).files.length;
const apartmentFiles = apartments.verifyPreparedAssets(root).files.length;
if (!fs.existsSync(light)) throw new Error('Missing evening light map. Run node scripts/art-preview.cjs prepare.');
const lightSHA = crypto.createHash('sha256').update(fs.readFileSync(light)).digest('hex');
console.log('Verified ' + apartmentFiles + ' apartment textures, ' + propFiles + ' prop files and station art ' + release.sha256);
console.log('Evening light SHA-256 ' + lightSHA);

if (command === 'serve') {
  const port = Number(portInput ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Expected a TCP port from 0 to 65535');
  const server = createStaticServer(root);
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log('Open http://127.0.0.1:' + server.address().port + '/'));
}
