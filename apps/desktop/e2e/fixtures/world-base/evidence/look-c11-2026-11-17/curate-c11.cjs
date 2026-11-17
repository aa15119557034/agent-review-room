// External C11 curation: exact current evidence, prior rounds linked only. Run --write after root authorization; no scene/GPU/download execution.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const fixture = path.resolve(__dirname, '../world-base/apps/desktop/e2e/fixtures/world-base');
const out = path.join(fixture, 'evidence/look-c11-2026-11-17');
const head = 'e1f32af2cfcde2e1e958a0dffb87f8d219886d5c';
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
  if (process.argv.length === 2 || process.argv.includes('--help')) { console.log('Await root authorization, then: node handoff/x51-curate-c11.cjs --write --readme=<handoff-basename.md>'); return; }
  const args = process.argv.slice(2), readmeArg = args.find(arg => arg.startsWith('--readme='));
  if (args.filter(arg => arg === '--write').length !== 1 || args.length !== (readmeArg ? 2 : 1) || args.some(arg => arg !== '--write' && arg !== readmeArg)) throw new Error('Expected --write and optional --readme=<handoff-basename.md>');
  const readmeName = readmeArg?.slice('--readme='.length);
  if (!readmeArg || !/^[\w.-]+\.md$/.test(readmeName)) throw new Error('C11 curation requires --readme=<handoff-basename.md> from root visual review');
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
    { label: 'baseline', directory: 'gpu-town-c11', report: 'render-report.json', baseline: true },
    { label: 'diagnostic', directory: 'gpu-look-c11-v1', report: 'look-report.json', driver: 'x51-c11-look-diagnostic-gpu.cjs', shadowComparison: true },
    { label: 'diagnostic-samples', directory: 'gpu-ao-c11-samples-v1', report: 'look-report.json', driver: 'x51-c11-ao-samples-gpu.cjs', samples: true },
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
    if (spec.shadowComparison) {
      const shadowAudit = read(path.join(run, 'city-shadow-audit.json'));
      if (JSON.stringify(shadowAudit) !== JSON.stringify(report.cityShadowAudit)) throw new Error('Standalone city shadow audit differs from full report');
      const previous = read(path.join(run, 'c10-shadow-reference.json'));
      const previousManifest = JSON.parse(gitFile('evidence/look-c10-2026-11-17/diagnostic/source-manifest.json'));
      if (previous.sourceHead !== '53cb20a8c017eba04bc8dae1437a8179071a1b9d' || previousManifest.head !== previous.sourceHead || previous.citySourceSha256 !== previousManifest.files['src/city.js'] || previous.reportSha256 !== hash(zlib.gunzipSync(gitFile('evidence/look-c10-2026-11-17/diagnostic/look-report.json.gz')))) throw new Error('Historical C10 shadow reference differs from committed evidence');
      for (const name of ['city-shadow-audit.json', 'c10-shadow-reference.json']) copy(path.join(run, name), spec.label + '/' + name);
    }
    for (const name of ['source-manifest.json', 'run-config.json', 'process.json']) copy(path.join(run, name), spec.label + '/' + name);
    gzip(path.join(run, 'electron.log'), spec.label + '/electron.log.gz');
    gzip(path.join(run, spec.report), spec.label + '/' + spec.report + '.gz');
    const images = spec.samples ? ['shop-interior-ao-on-capture-2.jpg', 'shop-interior-ao-on-capture-2.png']
      : spec.baseline ? ['01-station-street.jpg', '02-station-port.jpg', '03-island-aerial.jpg', '04-shop-interior.jpg', '18-town-shop-balconies.jpg', '19-town-rear-stairs.jpg', '23-service-corner.jpg', '24-laundry-details.jpg', '23-service-corner.png', '24-laundry-details.png', 'walking-first.jpg', 'walking-third.jpg']
      : diagnosticViews.flatMap(view => ['on', 'off'].flatMap(state => [view + '-ao-' + state + '-capture-2.jpg', ...(['service-corner-legacy-c8', 'shop-interior', '20-rear-eye', '21-front-eye'].includes(view) ? [view + '-ao-' + state + '-capture-2.png'] : [])]));
    if (spec.shadowComparison) images.push(...['20-rear-eye', '21-front-eye'].flatMap(view => ['original', 'diagnostic-four-toon-on', 'restored'].flatMap(mode => ['jpg', 'png'].map(ext => 'shadow-' + view + '-' + mode + '-capture-2.' + ext))));
    for (const image of images) {
      const capture = [...(report.captures || []), ...(report.shadowFlagCaptures || [])].find(c => typeof c === 'object' && c.name + '.png' === image);
      if (capture?.pngSha256 && hash(fs.readFileSync(path.join(run, image))) !== capture.pngSha256) throw new Error('Original PNG hash mismatch: ' + image);
      copy(path.join(run, image), spec.label + '/' + image);
    }
    if (!spec.baseline) {
      const index = [];
      for (const group of ['captures', 'shadowFlagCaptures']) for (const capture of report[group] || []) {
        const files = {};
        for (const ext of ['png', 'jpg']) {
          const filename = relative(capture.name + '.' + ext), bytes = fs.readFileSync(path.join(run, filename));
          files[ext] = { filename, bytes: bytes.length, sha256: hash(bytes), copiedToArchive: images.includes(filename) };
        }
        if (files.png.sha256 !== capture.pngSha256) throw new Error('Capture index PNG changed since report: ' + capture.name);
        index.push({ group, ...pick(capture, ['name', 'view', 'mode', 'pass', 'time', 'camera', 'uploadedAO']), files });
      }
      if (new Set(index.map(row => row.name)).size !== index.length) throw new Error('Duplicate capture name in full diagnostic index');
      json({ artifact: spec.directory, records: index, allCaptureMetadata: spec.report + '.gz', note: 'Every original capture is indexed and its PNG/JPG bytes hashed. Only predetermined second-frame images are copied; other pixels remain in the original artifact directory, while all metadata remains in the full report.' }, spec.label + '/capture-index.json');
    }
    const samples = fs.readdirSync(run).filter(name => /^frame-samples.*\.json$/.test(name));
    for (const name of samples) copy(path.join(run, name), spec.label + '/' + name);
    let samplingEvidence;
    if (spec.samples) {
      const data = read(path.join(run, 'gpu-ao-samples.json'));
      if (JSON.stringify(data) !== JSON.stringify(report.gpuSamples)) throw new Error('Standalone GPU samples differ from full report');
      if (hash(Buffer.from(data.exactFunctions)) !== data.exactFunctionsSha256) throw new Error('Extracted GPU shader function hash mismatch');
      samplingEvidence = { dataFile: 'gpu-ao-samples.json.gz', method: data.method, output: data.output, glError: data.glError, rawFloatCount: data.rawFloat32.length,
        centres: data.centres.map(centre => ({ pixel: centre.pixel, gpuAO: centre.gpuAO, sumContributions: centre.sumContributions, aoFromGPUContributions: centre.aoFromGPUContributions, agreementError: centre.agreementError, tapCount: centre.samples.length })),
        totalTapCount: data.centres.reduce((sum, centre) => sum + centre.samples.length, 0), maxAgreementError: Math.max(...data.centres.map(centre => centre.agreementError)),
        rendererRestored: data.rendererRestored, temporaryResourcesDisposed: data.temporaryResourcesDisposed, rayLimit: data.rayLimit, exactFunctionsSha256: data.exactFunctionsSha256 };
      gzip(path.join(run, 'gpu-ao-samples.json'), spec.label + '/gpu-ao-samples.json.gz');
    }
    const summary = { source, ...pick(report, ['stage', 'completedAt', 'ok', 'renderOk', 'transportClean', 'versions', 'performance', 'sourceUnchanged', 'driverUnchanged', 'assetsUnchanged', 'changedSourceFiles', 'restore', 'restoreFailure', 'initial', 'walkingValidation', 'behaviorValidation', 'lookValidation', 'townDetailCaptures', 'lightPixelComparisons', 'networkFailures', 'failedRequestTiming', 'failedRequestTimingNote', 'httpErrors', 'exceptions', 'failure']),
      strictExpectedExitFromReport: report.ok ? 0 : 1, exitScope: 'Derived from driver/report ok; not a persisted OS process exit observation.',
      firstReady: pick(report.firstReady, ['revision', 'dimensions', 'renderer', 'quality', 'timing', 'texturedProps', 'city']), views: report.views?.map(({ scene, ...view }) => view),
      selectedImages: images, frameSamples: samples,
      samplingEvidence,
      selectedCaptures: report.captures?.filter(c => typeof c === 'object' && images.includes(c.name + '.jpg')),
      shadowFlagCaptures: report.shadowFlagCaptures?.filter(c => images.includes(c.name + '.jpg')) };
    if (!spec.baseline) summary.scope = 'Fixed-time AO on/off views and real runtime asset/material readback; no performance claims from these captures. Legacy C8 camera and recorded raw ROI reference are preserved separately. Loaded materials/renderOk do not by themselves establish visual/style acceptance.';
    if (spec.samples) summary.scope = 'Only shop AO-on with warmup and two captures. Extra GPU readback records six centers times sixteen samples, exact diagnostic shader/hash and raw Float32 values to identify occluders. It is a causal sampling diagnostic, not a fix, visual approval or performance measurement. Full report and raw sampling data are retained independently.';
    if (spec.shadowComparison) summary.shadowScope = 'The 18 shadow-flag captures are separate from the original 42 AO captures. Original -> four noncasting Toon bins enabled -> restored is a bounded diagnostic, not a product fix. C10 reference contains two historically observed lamp meshes plus separately labeled whole-city inference from old source; it is not a full historical mesh observation.';
    json(summary, spec.label + '/measurements.json');
    checks.push({ artifact: spec.directory, ...source });
    outcomes.push({ artifact: spec.directory, ...pick(report, ['ok', 'renderOk', 'transportClean', 'sourceUnchanged', 'driverUnchanged', 'assetsUnchanged']), strictExpectedExitFromReport: summary.strictExpectedExitFromReport });
  }
  const ci = read(path.join(__dirname, 'x51-c11-ci-summary.json'));
  if (ci.head !== head || ci.logSha256 !== hash(fs.readFileSync(path.join(__dirname, 'x51-c11-ci-log.json')))) throw new Error('CI source/log mismatch');
  for (const name of ['x51-c11-ci-summary.json', 'x51-c11-ci-checks.json', 'x51-c11-ci-jobs.json', 'x51-c11-ci-summary.cjs']) copy(path.join(__dirname, name), 'ci/' + name);
  gzip(path.join(__dirname, 'x51-c11-ci-log.json'), 'ci/job-log.json.gz');
  const analysisSpecs = [
    { stem: 'x51-c11-look-v1-analysis', run: 'gpu-look-c11-v1', inputs: { driver: 'x51-c11-look-diagnostic-gpu.cjs', offlineDriver: 'x51-c11-look-offline-analysis.cjs', report: 'look-report.json', cityAudit: 'city-shadow-audit.json', sourceManifest: 'source-manifest.json', assetManifest: 'prop-assets-manifest.json' } },
    { stem: 'x51-c11-ao-samples-v1-analysis', run: 'gpu-ao-c11-samples-v1', inputs: { driver: 'x51-c11-ao-samples-gpu.cjs', offlineDriver: 'x51-c11-ao-samples-offline-analysis.cjs', report: 'look-report.json', gpuSamples: 'gpu-ao-samples.json', sourceManifest: 'source-manifest.json', assetManifest: 'prop-assets-manifest.json' } },
  ];
  const analysisExits = [];
  for (const spec of analysisSpecs) {
    const analysis = read(path.join(__dirname, spec.stem + '.json'));
    if (analysis.head !== head) throw new Error('C11 analysis belongs to another head: ' + spec.stem);
    for (const [key, name] of Object.entries(spec.inputs)) {
      const file = path.join(key === 'driver' || key === 'offlineDriver' ? __dirname : path.join(fixture, 'artifacts', spec.run), name);
      if (hash(fs.readFileSync(file)) !== analysis.hashes[key]) throw new Error('C11 analysis input hash differs: ' + spec.stem + ' ' + key);
    }
    const processRecord = read(path.join(fixture, 'artifacts', spec.run, 'process.json'));
    if (analysis.process.pid !== processRecord.pid) throw new Error('C11 analysis process record differs: ' + spec.run);
    analysisExits.push({ artifact: spec.run, exitCode: analysis.process.actualExitCode, rootExecSession: analysis.process.session, processId: analysis.process.pid, evidence: 'Frozen runtime analysis actual runner record; PID matches original process.json' });
    for (const file of [spec.stem + '.json', spec.stem + '.md', spec.inputs.offlineDriver]) copy(path.join(__dirname, file), 'analysis/' + file);
  }
  const audit = read(path.join(__dirname, 'x51-c11-readonly-audit.json'));
  const shadowResult = read(path.join(__dirname, 'x51-c11-city-shadow-result.json'));
  if (audit.head !== head) throw new Error('C11 read-only audit belongs to another source head');
  for (const sourceHashes of [audit.sourceHashes, shadowResult.sourceHashes]) for (const [file, sha] of Object.entries(sourceHashes)) if (hash(gitFile(file)) !== sha) throw new Error('C11 CPU shadow/source mismatch: ' + file);
  const shadowDriver = path.join(__dirname, 'x51-c11-city-shadow-driver.mjs');
  if (hash(fs.readFileSync(shadowDriver)) !== audit.driverSha256 || hash(fs.readFileSync(path.join(__dirname, 'x51-c11-city-shadow-result.json'))) !== audit.resultSha256) throw new Error('C11 shadow audit driver/result hash mismatch');
  for (const file of ['x51-c11-readonly-audit.json', 'x51-c11-readonly-audit.md', 'x51-c11-city-shadow-driver.mjs', 'x51-c11-city-shadow-result.json', 'x51-frame-shapes.cjs']) copy(path.join(__dirname, file), 'cpu/' + file);
  json({ head, commands: audit.commands, driverSha256: audit.driverSha256, resultSha256: audit.resultSha256,
    scope: 'This round uses the real city GB/material/GLTF geometry with mocked image pixels. CPU mesh flags, construction stacks, topology and disposal counts are not GPU shadow-map or visibility proof. CPU/GPU four-bin matching covers triangle count, material type, exact world bounds and flags; CPU has no attribute-byte hashes, so it does not establish byte-identical geometry. No C10 failed driver, result or cast-shadow erratum is reused as C11 evidence.',
    frameScope: 'Root reported this baseline sample only: initial 982 frames plus four fixed views and two walking segments all had zero frames above 20ms; initial maximum was 15.8ms. This does not establish that a performance root cause was fixed. Raw segment samples remain authoritative.', limitations: audit.limitations }, 'cpu/scope.json');
  const references = [
    'evidence/look-c10-2026-11-17/README.md',
    'evidence/look-c10-2026-11-17/baseline/23-service-corner.jpg',
    'evidence/look-c10-2026-11-17/baseline/24-laundry-details.jpg',
    'evidence/look-c10-2026-11-17/diagnostic/shop-interior-ao-on-capture-2.png',
    'evidence/look-c10-2026-11-17/diagnostic/20-rear-eye-ao-on-capture-2.png',
    'evidence/look-c10-2026-11-17/analysis/x51-c10-look-v1-analysis.json',
    'evidence/look-c10-2026-11-17/analysis/x51-c10-ao-samples-v1-analysis.json',
    'evidence/textured-props-2026-11-17/shutter-grade/grade-report.json.gz',
  ];
  json(references.map(file => ({ file: '../' + file.slice('evidence/'.length), presentInCommit: head, sha256: hash(gitFile(file)), copied: false })), 'prior-references.json');
  copy(__filename, 'curate-c11.cjs');
  json({ source: 'Root and frozen runtime runner observations, not inferred from report.ok.', runs: [{ artifact: 'gpu-town-c11', exitCode: 1, rootExecSession: 84840, processId: 56620 }, ...analysisExits], note: 'All original transport failures remain in full reports and measurements. No green-only selection or retry.' }, 'observed-exits.json');
  queue(Buffer.from('*.gz binary\n*.png binary\n*.jpg binary\n*.json -text\n*.cjs -text\n*.mjs -text\n*.md -text\n'), '.gitattributes');
  copy(path.join(__dirname, readmeName), 'README.md');
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
