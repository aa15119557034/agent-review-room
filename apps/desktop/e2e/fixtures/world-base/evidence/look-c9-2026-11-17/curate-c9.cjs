// External curation only. Run --write after root authorization; never executes scene/GPU/downloads.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const fixture = path.resolve(__dirname, '../world-base/apps/desktop/e2e/fixtures/world-base');
const out = path.join(fixture, 'evidence/look-c9-2026-11-17');
const head = '1b63536ef0dae7c9f28d92efda01b0740e9a005a';
const reviewGit = 'D:/codex/2026-10-21/agent-https-github-com-aa15119557034-agent/work/review_git.cjs';
const prefix = 'apps/desktop/e2e/fixtures/world-base/';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest('hex');
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..' || !/^[\w.-]+$/.test(part))) throw new Error('Invalid relative path: ' + value);
  return value;
}
const blobs = new Map();
function gitFile(file) {
  relative(file);
  if (file.startsWith('.local/')) throw new Error('Never git show ignored assets');
  if (!blobs.has(file)) blobs.set(file, cp.execFileSync(process.execPath, [reviewGit, 'show', head + ':' + prefix + file], { cwd: fixture, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }));
  return blobs.get(file);
}
function pinnedAssets() {
  const manifest = JSON.parse(gitFile('prop-assets.json'));
  if (manifest.preparedRoot !== '.local/textured-props' || manifest.files.length !== 9 || new Set(manifest.files.map(file => file.path)).size !== 9) throw new Error('Unexpected pinned asset set');
  const files = {}, root = fs.realpathSync(fixture);
  for (const entry of manifest.files) {
    const file = relative(manifest.preparedRoot + '/' + entry.path), real = fs.realpathSync(path.join(fixture, file));
    const rel = path.relative(root, real);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Asset escapes fixture');
    const bytes = fs.readFileSync(real), actual = { bytes: bytes.length, md5: hash(bytes, 'md5'), sha256: hash(bytes) };
    if (['bytes', 'md5', 'sha256'].some(key => actual[key] !== entry[key])) throw new Error('Pinned asset mismatch: ' + file);
    files[file] = actual;
  }
  return { commit: head, manifest: 'prop-assets.json', manifestSha256: hash(gitFile('prop-assets.json')), files };
}
function receipt(received, assets, label) {
  if (!received?.verifiedBeforeLaunch || !Array.isArray(received.files) || received.files.length !== 9 || new Set(received.files.map(file => file.path)).size !== 9) throw new Error('Missing/duplicate asset receipt: ' + label);
  for (const entry of received.files) if (!assets.files[entry.path] || ['bytes', 'md5', 'sha256'].some(key => entry[key] !== assets.files[entry.path][key])) throw new Error('Asset receipt mismatch: ' + label + ' ' + entry.path);
}
function sourceManifest(file, assets, embeddedReceipt) {
  const manifest = read(file);
  if (manifest.head !== head) throw new Error('Wrong source commit: ' + file);
  let tracked = 0, ignored = 0;
  for (const [name, sha] of Object.entries(manifest.files)) {
    if (name.startsWith('.local/')) {
      if (assets.files[name]?.sha256 !== sha) throw new Error('Unverified ignored manifest file: ' + name);
      ignored++;
    } else {
      if (hash(gitFile(name)) !== sha) throw new Error('Exact commit mismatch: ' + name);
      tracked++;
    }
  }
  if (ignored !== 9) throw new Error('Manifest must include all nine actual asset hashes');
  if (embeddedReceipt) receipt(manifest.propAssets, assets, file);
  return { head, sha256: hash(fs.readFileSync(file)), trackedFilesVerified: tracked, pinnedIgnoredFilesVerified: ignored, receipt: embeddedReceipt ? 'embedded' : 'separate prop-assets-manifest.json' };
}

function main() {
  if (process.argv.length === 2 || process.argv.includes('--help')) { console.log('Await root authorization, then: node handoff/x51-curate-c9.cjs --write [--readme=<handoff-basename.md>]'); return; }
  const args = process.argv.slice(2), readmeArg = args.find(arg => arg.startsWith('--readme='));
  if (args.filter(arg => arg === '--write').length !== 1 || args.length !== (readmeArg ? 2 : 1) || args.some(arg => arg !== '--write' && arg !== readmeArg)) throw new Error('Expected --write and optional --readme=<handoff-basename.md>');
  const readmeName = readmeArg?.slice('--readme='.length);
  if (readmeName && !/^[\w.-]+\.md$/.test(readmeName)) throw new Error('README must be a handoff Markdown basename');
  if (fs.existsSync(out)) throw new Error('Preserve existing evidence directory');
  const pending = [], names = new Set(), checks = [], outcomes = [];
  function queue(bytes, name, metadata = {}) {
    relative(name); if (names.has(name)) throw new Error('Duplicate archive name: ' + name); names.add(name);
    pending.push({ bytes, name, metadata });
  }
  function copy(file, name) { queue(fs.readFileSync(file), name, { source: path.relative(fixture, file).replaceAll('\\', '/') }); }
  function json(value, name) { queue(Buffer.from(JSON.stringify(value, null, 2) + '\n'), name, { generatedSummary: true }); }
  function gzip(file, name) {
    const raw = fs.readFileSync(file), compressed = zlib.gzipSync(raw, { level: 9 });
    if (hash(zlib.gunzipSync(compressed)) !== hash(raw)) throw new Error('Gzip round-trip mismatch');
    queue(compressed, name, { source: path.relative(fixture, file).replaceAll('\\', '/'), originalBytes: raw.length, originalSha256: hash(raw), losslessGzip: true });
  }
  const assets = pinnedAssets();
  json(assets, 'source-map/pinned-assets.json');
  queue(gitFile('prop-assets.json'), 'source-map/prop-assets.json', { exactCommit: head });
  const specs = [
    { label: 'baseline', directory: 'gpu-town-c9', report: 'render-report.json', baseline: true },
    { label: 'diagnostic', directory: 'gpu-look-c9-v1', report: 'look-report.json', driver: 'x51-c9-look-diagnostic-gpu.cjs' },
  ];
  const diagnosticViews = ['service-corner', 'laundry-details', 'shop-interior', '20-rear-eye', '21-front-eye', 'station-street', 'service-corner-legacy-c8'];
  for (const spec of specs) {
    const run = path.join(fixture, 'artifacts', spec.directory), report = read(path.join(run, spec.report)), config = read(path.join(run, 'run-config.json'));
    if (report.stage !== 'complete') throw new Error('Run not finalized: ' + spec.directory);
    const source = sourceManifest(path.join(run, 'source-manifest.json'), assets, spec.baseline === true);
    if (config.sourceManifest?.sha256 && config.sourceManifest.sha256 !== source.sha256) throw new Error('Config/source manifest mismatch');
    if (report.headAfter !== undefined && report.headAfter !== head) throw new Error('Diagnostic source head changed');
    if (!spec.baseline) {
      receipt(read(path.join(run, 'prop-assets-manifest.json')), assets, spec.directory);
      copy(path.join(run, 'prop-assets-manifest.json'), spec.label + '/prop-assets-manifest.json');
      const driver = path.join(__dirname, spec.driver);
      if (hash(fs.readFileSync(driver)) !== config.driverSha256) throw new Error('Diagnostic driver changed');
      copy(driver, spec.label + '/' + spec.driver);
      const legacy = read(path.join(run, 'legacy-c8-reference.json'));
      const oldReport = gitFile('evidence/textured-props-2026-11-17/shutter-grade/grade-report.json.gz');
      if (hash(zlib.gunzipSync(oldReport)) !== legacy.reference.sha256) throw new Error('Legacy C8 reference does not match committed evidence');
      copy(path.join(run, 'legacy-c8-reference.json'), spec.label + '/legacy-c8-reference.json');
    }
    for (const name of ['source-manifest.json', 'run-config.json', 'process.json']) copy(path.join(run, name), spec.label + '/' + name);
    gzip(path.join(run, 'electron.log'), spec.label + '/electron.log.gz');
    gzip(path.join(run, spec.report), spec.label + '/' + spec.report + '.gz');
    const images = spec.baseline ? ['01-station-street.jpg', '02-station-port.jpg', '03-island-aerial.jpg', '04-shop-interior.jpg', '18-town-shop-balconies.jpg', '19-town-rear-stairs.jpg', '23-service-corner.jpg', '24-laundry-details.jpg', '23-service-corner.png', '24-laundry-details.png', 'walking-first.jpg', 'walking-third.jpg']
      : diagnosticViews.flatMap(view => ['on', 'off'].flatMap(state => [view + '-ao-' + state + '-capture-2.jpg', ...(['service-corner-legacy-c8', 'shop-interior', '20-rear-eye', '21-front-eye'].includes(view) ? [view + '-ao-' + state + '-capture-2.png'] : [])]));
    for (const image of images) {
      const capture = report.captures?.find(c => typeof c === 'object' && c.name + '.png' === image);
      if (capture?.pngSha256 && hash(fs.readFileSync(path.join(run, image))) !== capture.pngSha256) throw new Error('Original PNG hash mismatch: ' + image);
      copy(path.join(run, image), spec.label + '/' + image);
    }
    const samples = fs.readdirSync(run).filter(name => /^frame-samples.*\.json$/.test(name));
    for (const name of samples) copy(path.join(run, name), spec.label + '/' + name);
    const summary = { source, ...pick(report, ['stage', 'completedAt', 'ok', 'renderOk', 'transportClean', 'versions', 'performance', 'sourceUnchanged', 'driverUnchanged', 'assetsUnchanged', 'changedSourceFiles', 'restore', 'restoreFailure', 'initial', 'walkingValidation', 'behaviorValidation', 'lookValidation', 'townDetailCaptures', 'networkFailures', 'failedRequestTiming', 'failedRequestTimingNote', 'httpErrors', 'exceptions', 'failure']),
      strictExpectedExitFromReport: report.ok ? 0 : 1, exitScope: 'Derived from driver/report ok; not a persisted OS process exit observation.',
      firstReady: pick(report.firstReady, ['revision', 'dimensions', 'renderer', 'quality', 'timing', 'texturedProps', 'city']), views: report.views?.map(({ scene, ...view }) => view),
      selectedImages: images, frameSamples: samples,
      selectedCaptures: report.captures?.filter(c => typeof c === 'object' && images.includes(c.name + '.jpg')) };
    if (!spec.baseline) summary.scope = 'Fixed-time AO on/off views and real runtime asset/material readback; no performance claims from these captures. Legacy C8 camera and recorded raw ROI reference are preserved separately. Loaded materials/renderOk do not by themselves establish visual/style acceptance.';
    json(summary, spec.label + '/measurements.json');
    checks.push({ artifact: spec.directory, ...source });
    outcomes.push({ artifact: spec.directory, ...pick(report, ['ok', 'renderOk', 'transportClean', 'sourceUnchanged', 'driverUnchanged', 'assetsUnchanged']), strictExpectedExitFromReport: summary.strictExpectedExitFromReport });
  }
  const ci = read(path.join(__dirname, 'x51-c9-ci-summary.json'));
  if (ci.head !== head || ci.logSha256 !== hash(fs.readFileSync(path.join(__dirname, 'x51-c9-ci-log.json')))) throw new Error('CI source/log mismatch');
  for (const name of ['x51-c9-ci-summary.json', 'x51-c9-ci-checks.json', 'x51-c9-ci-jobs.json', 'x51-c9-ci-summary.cjs']) copy(path.join(__dirname, name), 'ci/' + name);
  gzip(path.join(__dirname, 'x51-c9-ci-log.json'), 'ci/job-log.json.gz');
  const analysis = read(path.join(__dirname, 'x51-c9-look-v1-analysis.json'));
  if (analysis.sourceHead !== head) throw new Error('Analysis belongs to a different source commit');
  for (const [file, sha] of Object.entries(analysis.evidenceHashes)) {
    relative(file);
    if (hash(fs.readFileSync(path.join(fixture, 'artifacts/gpu-look-c9-v1', file))) !== sha) throw new Error('Analysis input changed: ' + file);
  }
  if (hash(fs.readFileSync(path.join(__dirname, 'x51-c9-look-diagnostic-gpu.cjs'))) !== analysis.driverSha256) throw new Error('Analysis GPU driver hash mismatch');
  copy(path.join(__dirname, 'x51-c9-look-v1-analysis.json'), 'analysis/x51-c9-look-v1-analysis.json');
  const offlineDriver = path.join(__dirname, 'x51-c9-look-offline-analysis.cjs');
  if (hash(fs.readFileSync(offlineDriver)) !== analysis.offlineReproduction?.sha256) throw new Error('Offline analysis driver differs from recorded reproduction');
  copy(offlineDriver, 'analysis/x51-c9-look-offline-analysis.cjs');
  copy(path.join(__dirname, 'x51-c9-look-v1-analysis.md'), 'analysis/x51-c9-look-v1-analysis.md');
  const cpu = read(path.join(__dirname, 'x51-c9-look-cpu-result.json'));
  for (const [file, sha] of Object.entries(cpu.sourceHashes)) if (hash(gitFile(file)) !== sha) throw new Error('CPU result/source commit mismatch: ' + file);
  for (const file of ['x51-c9-look-cpu-driver.cjs', 'x51-c9-look-cpu-result.json']) copy(path.join(__dirname, file), 'cpu/' + file);
  json({ head, sourceHashesVerifiedAgainstCommit: cpu.sourceHashes, resultSha256: hash(fs.readFileSync(path.join(__dirname, 'x51-c9-look-cpu-result.json'))), preservedDriverSha256: hash(fs.readFileSync(path.join(__dirname, 'x51-c9-look-cpu-driver.cjs'))),
    scope: 'CPU literal/math checks and result only; neither shader compilation nor rendered appearance/GPU proof. Driver is preserved at curation time; the original result does not record its driver hash. Curation does not rerun this analysis.', limitations: cpu.limits }, 'cpu/scope.json');
  const references = [
    'evidence/textured-props-2026-11-17/README.md',
    'evidence/textured-props-2026-11-17/final/23-service-corner.jpg',
    'evidence/textured-props-2026-11-17/final/24-laundry-details.jpg',
    'evidence/textured-props-2026-11-17/shutter-grade/grade-report.json.gz',
    'evidence/textured-props-2026-11-17/ao/measurements.json',
  ];
  json(references.map(file => ({ file: '../' + file.slice('evidence/'.length), presentInCommit: head, sha256: hash(gitFile(file)), copied: false })), 'c8-references.json');
  copy(__filename, 'curate-c9.cjs');
  json({ source: 'Root runner observations supplied in the curation handoff; these are not inferred from report.ok.', runs: [{ artifact: 'gpu-town-c9', exitCode: 1, rootExecSession: 31136 }, { artifact: 'gpu-look-c9-v1', exitCode: 1 }], note: 'Both runs rendered successfully but retained crate glTF ERR_ABORTED transport failures. No retry to obtain green evidence.' }, 'observed-exits.json');
  queue(Buffer.from('*.gz binary\n*.png binary\n*.jpg binary\n*.json -text\n*.cjs -text\n*.md -text\n'), '.gitattributes');
  if (readmeName) copy(path.join(__dirname, readmeName), 'README.md');
  else queue(Buffer.from('# C9 look evidence\n\nSource: `' + head + '`. Original selected screenshot bytes and raw frame samples are preserved; complete reports and logs are lossless gzip. See `summary.json` for actual outcomes and `provenance.json` for every archived file hash. No success-only filtering, image recompression, runtime caches or asset originals.\n\n[Previous C8 evidence](../textured-props-2026-11-17/README.md) remains the historical reference. `c8-references.json` pins linked files to this commit; `diagnostic/legacy-c8-reference.json` identifies the exact old camera/HDR/pixel reference used. Old C8 evidence is not duplicated or relabeled as C9.\n\nNormal baseline FPS is separate from fixed-time causal screenshots. `renderOk`, transport status and style judgment remain distinct. Derived driver exit status is not falsely labeled a persisted shell exit. CI is tied only to the exact C9 source commit.\n'), 'README.md');
  json({ createdAt: new Date().toISOString(), head, checks, outcomes, ci: pick(ci, ['head', 'run', 'job', 'url', 'result', 'completedAt', 'tests', 'passed', 'types', 'builds', 'allExitZero']),
    method: 'Tracked source checked against exact commit via read-only review_git show. Nine ignored assets checked against that commit prop-assets.json and actual size/MD5/SHA. Baseline embedded receipt and diagnostic separate receipt verified independently. All original report records retained, selected predetermined capture-2 images copied unchanged. Warmup/first-capture pixels remain in original artifact directories. Logs gzip prevents *.log ignore and newline conversion.',
    limitations: 'No whole-world or style acceptance is inferred, no assets/cache/user profiles copied, no GPU or scene execution in this script. Absolute original paths in reports are forensic metadata; replay drivers still require the original workspace layout and local assets.' }, 'summary.json');
  // Finish all verification before creating evidence. Refuse any pre-existing destination.
  fs.mkdirSync(out, { recursive: true });
  const files = [];
  for (const item of pending) {
    const target = path.join(out, item.name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, item.bytes, { flag: 'wx' });
    files.push({ file: item.name, bytes: item.bytes.length, sha256: hash(item.bytes), ...item.metadata });
  }
  fs.writeFileSync(path.join(out, 'provenance.json'), JSON.stringify({ head, createdAt: new Date().toISOString(), files, countExcludesThisInventory: true }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ out, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), outcomes }, null, 2));
}
if (require.main === module) { try { main(); } catch (error) { console.error(error); process.exitCode = 1; } }
