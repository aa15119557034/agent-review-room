// CPU-only checks. No Electron process, canvas, Git command or WebGL is started.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), vm = require('node:vm'), { EventEmitter } = require('node:events');
const fixture = path.resolve(__dirname, '../world-base/apps/desktop/e2e/fixtures/world-base');
const source = path.resolve(__dirname, '../asset-candidates/textured-props');
const prep = require(path.join(fixture, 'scripts/prepare-props.cjs'));
const { createStaticServer } = require(path.join(fixture, 'scripts/baseline.cjs'));
const manifest = prep.readManifest(fixture);
const work = fs.mkdtempSync(path.join(fixture, '.local/prop-preparation-checks-'));
const checks = [];
const hash = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest('hex');
function caseRoot(name) {
  const root = path.join(work, name); fs.mkdirSync(root);
  fs.copyFileSync(path.join(fixture, 'prop-assets.json'), path.join(root, 'prop-assets.json'));
  return root;
}
function expectReject(name, fn, pattern) {
  let error;
  try { fn(); } catch (caught) { error = caught; }
  assert.ok(error, name + ' must reject'); assert.match(error.message, pattern);
  checks.push({ name, ok: true, rejection: error.message });
}
function target(root, entry = manifest.files[0]) { return path.join(root, manifest.preparedRoot, entry.path); }
function filled(name) { const root = caseRoot(name); prep.prepare({ root, source }); return root; }
function saveManifest(root, value) { fs.writeFileSync(path.join(root, 'prop-assets.json'), JSON.stringify(value)); }
async function main() {
  const real = prep.verifyPreparedAssets(fixture);
  assert.equal(real.files.length, 9); assert.equal(real.totalBytes, 3579256);
  checks.push({ name: 'real local nine original files, size/MD5/SHA and closure', ok: true });
  const good = filled('good');
  assert.deepEqual(prep.prepare({ root: good }).files, prep.verifyPreparedAssets(good).files);
  checks.push({ name: 'copy source and repeat verify without overwrite', ok: true });

  const dirty = filled('bad-target');
  const bytes = fs.readFileSync(target(dirty)); bytes[0] ^= 1; fs.writeFileSync(target(dirty), bytes);
  expectReject('same-size corrupt existing target', () => prep.prepare({ root: dirty, source }), /md5 mismatch/);
  assert.equal(hash(fs.readFileSync(target(dirty))), hash(bytes));
  const short = filled('short-target'); fs.writeFileSync(target(short), Buffer.from('bad'));
  expectReject('wrong-size target', () => prep.prepare({ root: short, source }), /bytes mismatch/);
  assert.equal(fs.readFileSync(target(short), 'utf8'), 'bad');

  const badSource = path.join(work, 'bad-source'); fs.mkdirSync(badSource);
  for (const entry of manifest.files) { const file = path.join(badSource, entry.localSource); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(source, entry.localSource), file); }
  fs.writeFileSync(path.join(badSource, manifest.files[0].localSource), bytes);
  const untouched = caseRoot('bad-source-destination');
  expectReject('same-size corrupt source before target writes', () => prep.prepare({ root: untouched, source: badSource }), /md5 mismatch/);
  assert.equal(fs.existsSync(path.join(untouched, manifest.preparedRoot)), false);
  expectReject('missing target without acquisition option', () => prep.prepare({ root: caseRoot('missing') }), /Missing/);

  const escape = caseRoot('manifest-escape'), escapedManifest = structuredClone(manifest);
  escapedManifest.files[0].path = '../outside.gltf'; saveManifest(escape, escapedManifest);
  expectReject('manifest traversal', () => prep.prepare({ root: escape, source }), /Invalid asset relative path/);

  const junction = caseRoot('target-junction'), outside = path.join(work, 'outside-target'); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(junction, '.local')); fs.symlinkSync(outside, path.join(junction, manifest.preparedRoot), 'junction');
  expectReject('target root junction escape', () => prep.prepare({ root: junction, source }), /Path escapes/);
  assert.equal(fs.readdirSync(outside).length, 0);
  const sourceJunction = path.join(work, 'source-junction'); fs.mkdirSync(sourceJunction);
  fs.symlinkSync(path.join(source, 'downloads'), path.join(sourceJunction, 'downloads'), 'junction');
  expectReject('source junction escape', () => prep.prepare({ root: caseRoot('source-junction-destination'), source: sourceJunction }), /Path escapes/);

  const stale = caseRoot('stale-part');
  const part = target(stale) + '.part'; fs.mkdirSync(path.dirname(part), { recursive: true }); fs.writeFileSync(part, 'inspection evidence');
  expectReject('stale partial preserved', () => prep.prepare({ root: stale, source }), /EEXIST/);
  assert.equal(fs.readFileSync(part, 'utf8'), 'inspection evidence');

  const closure = filled('bad-closure'), closureManifest = structuredClone(manifest);
  const gltf = JSON.parse(fs.readFileSync(target(closure), 'utf8'));
  gltf.images[0].uri = 'textures/missing.jpg';
  const altered = Buffer.from(JSON.stringify(gltf)); fs.writeFileSync(target(closure), altered);
  const first = closureManifest.files[0]; closureManifest.totalBytes += altered.length - first.bytes;
  Object.assign(first, { bytes: altered.length, md5: hash(altered, 'md5'), sha256: hash(altered) }); saveManifest(closure, closureManifest);
  expectReject('hashed glTF with unlisted dependency', () => prep.verifyPreparedAssets(closure), /unlisted dependency/);

  const download = filled('official-download'); fs.unlinkSync(target(download));
  const oldProxy = process.env.WORLD_BASE_PROXY;
  process.env.WORLD_BASE_PROXY = oldProxy || 'http://127.0.0.1:7897';
  try { assert.equal(prep.prepare({ root: download, download: true }).files.length, 9); }
  finally { if (oldProxy === undefined) delete process.env.WORLD_BASE_PROXY; else process.env.WORLD_BASE_PROXY = oldProxy; }
  checks.push({ name: 'real official HTTPS curl download of missing 2947-byte glTF; remaining eight preverified', ok: true });

  const server = createStaticServer(fixture);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const entry of manifest.files) {
      const response = await fetch(base + manifest.route + entry.path);
      assert.equal(response.status, 200); assert.equal(Number(response.headers.get('content-length')), entry.bytes);
      assert.equal(hash(Buffer.from(await response.arrayBuffer())), entry.sha256);
    }
    const head = await fetch(base + manifest.route + manifest.files[0].path, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(base + '/.local/textured-props/' + manifest.files[0].path)).status, 403);
    assert.equal((await fetch(base + '/prop-assets/%2e%2e%2fprop-assets.json')).status, 403);
    checks.push({ name: 'Node HTTP GET nine SHA/lengths; HEAD; direct .local and encoded traversal blocked', ok: true });
  } finally { await new Promise(resolve => server.close(resolve)); }

  // Run the actual baseline control flow in a synthetic fixture with process/Git creation stubbed.
  const captureRoot = filled('baseline-preflight'); fs.mkdirSync(path.join(captureRoot, 'scripts'));
  for (const file of ['prepare-props.cjs', 'baseline.cjs']) fs.copyFileSync(path.join(fixture, 'scripts', file), path.join(captureRoot, 'scripts', file));
  fs.writeFileSync(path.join(captureRoot, 'index.html'), '<!doctype html><title>CPU synthetic fixture</title>');
  fs.copyFileSync(path.join(fixture, 'city-assets.json'), path.join(captureRoot, 'city-assets.json'));
  let spawnCount = 0;
  function launchBaseline(output) {
    const sandboxModule = { exports: {} };
    const cpStub = { execFileSync: () => 'SYNTHETIC-CPU-ONLY-NO-GIT', spawn: () => { spawnCount++; return new EventEmitter(); } };
    const localRequire = name => name === 'node:child_process' ? cpStub : name === './prepare-props.cjs' ? prep : require(name);
    localRequire.main = sandboxModule;
    const sandboxProcess = { argv: [process.execPath, 'baseline.cjs', '--electron=' + process.execPath, '--stills', '--output=' + output], env: process.env, exitCode: 0 };
    const errors = [];
    vm.runInNewContext(fs.readFileSync(path.join(fixture, 'scripts/baseline.cjs'), 'utf8'), { require: localRequire, module: sandboxModule, __dirname: path.join(captureRoot, 'scripts'), __filename: path.join(captureRoot, 'scripts/baseline.cjs'), process: sandboxProcess, console: { log() {}, error(error) { errors.push(String(error)); } } });
    return { errors, exitCode: sandboxProcess.exitCode };
  }
  const output = path.join(work, 'synthetic-capture'); assert.equal(launchBaseline(output).errors.length, 0); assert.equal(spawnCount, 1);
  const snapshot = JSON.parse(fs.readFileSync(path.join(output, 'source-manifest.json'), 'utf8'));
  assert.equal(snapshot.propAssets.files.length, 9);
  for (const file of snapshot.propAssets.files) assert.equal(snapshot.files[file.path], file.sha256);
  for (const file of ['prop-assets.json', 'scripts/prepare-props.cjs', 'scripts/baseline.cjs']) assert.equal(snapshot.files[file], hash(fs.readFileSync(path.join(captureRoot, file))));
  fs.writeFileSync(target(captureRoot), 'bad');
  const refused = launchBaseline(path.join(work, 'synthetic-refused'));
  assert.equal(refused.exitCode, 1); assert.equal(spawnCount, 1); assert.match(refused.errors.join(' '), /bytes mismatch/);
  checks.push({ name: 'actual baseline VM: nine actual hashes plus scripts in source manifest; bad file rejects before spawn (all child/Git calls stubbed)', ok: true });
  const transport = require(path.join(fixture, 'scripts/diagnose-asset-transport.cjs')).buildTargets();
  assert.equal(transport.targets.length, 12); assert.equal(transport.targets.length * 2 * 3, 72);
  assert.equal(new Set(transport.targets.map(t => t.name)).size, 12);
  checks.push({ name: 'transport target assembly 3 Petal + 9 props, 72 planned cases; no Electron transport execution', ok: true });
  const report = { ok: true, cpuOnly: true, gpuStarted: false, electronStarted: false, gitExecuted: false, work, checks };
  fs.writeFileSync(path.join(__dirname, 'x51-prop-preparation-checks.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
