// Run only after root authorizes curation. No GPU, scene execution, download or Git mutation.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const fixture = path.resolve(__dirname, '../world-base/apps/desktop/e2e/fixtures/world-base');
const out = path.join(fixture, 'evidence/textured-props-2026-11-17');
const reviewGit = 'D:/codex/2026-10-21/agent-https-github-com-aa15119557034-agent/work/review_git.cjs';
const originalCommit = '5463714131eba64f83a828ba509c023072f4d4ea';
const integratedCommit = '5cf3ef7d784ff069b87fef9b8051de63b6695e48';
const prefix = 'apps/desktop/e2e/fixtures/world-base/';
const hash = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const gitCache = new Map();

function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.split('/').some(v => !v || v === '.' || v === '..' || !/^[\w.-]+$/.test(v))) throw new Error('Invalid archive path: ' + value);
  return value;
}
function gitFile(commit, file) {
  relative(file);
  if (file.startsWith('.local/')) throw new Error('Never git show ignored binary: ' + file);
  const spec = commit + ':' + prefix + file;
  if (!gitCache.has(spec)) gitCache.set(spec, cp.execFileSync(process.execPath, [reviewGit, 'show', spec], { cwd: fixture, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }));
  return gitCache.get(spec);
}
function verifyPinnedProps(commit) {
  const manifest = JSON.parse(gitFile(commit, 'prop-assets.json'));
  if (manifest.preparedRoot !== '.local/textured-props' || manifest.files.length !== 9) throw new Error('Unexpected pinned prop selection');
  const actual = {};
  const realFixture = fs.realpathSync(fixture);
  for (const entry of manifest.files) {
    const file = relative(manifest.preparedRoot + '/' + entry.path);
    const local = fs.realpathSync(path.join(fixture, file));
    const rel = path.relative(realFixture, local);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Pinned asset escapes fixture: ' + file);
    const bytes = fs.readFileSync(local);
    if (bytes.length !== entry.bytes || hash(bytes, 'md5') !== entry.md5 || hash(bytes) !== entry.sha256) throw new Error('Pinned asset mismatch: ' + file);
    actual[file] = { bytes: bytes.length, md5: hash(bytes, 'md5'), sha256: hash(bytes), sourceUrl: entry.sourceUrl };
  }
  return { commit, manifest: 'prop-assets.json', manifestSha256: hash(gitFile(commit, 'prop-assets.json')), files: actual };
}
function verifyPropReceipt(receipt, pinned, label) {
  if (!receipt?.verifiedBeforeLaunch || !Array.isArray(receipt.files) || receipt.files.length !== 9 || new Set(receipt.files.map(entry => entry.path)).size !== 9) throw new Error('Missing or duplicate verified prop inputs: ' + label);
  for (const entry of receipt.files) {
    const actual = pinned.files[entry.path];
    if (!actual || ['bytes', 'md5', 'sha256'].some(key => entry[key] !== actual[key])) throw new Error('Prop receipt differs from pinned bytes: ' + label + ' ' + entry.path);
  }
}
function verifyManifest(file, commit, pinned, requireEmbeddedReceipt = false) {
  const manifest = read(file);
  if (manifest.head !== commit) throw new Error('Unexpected source-manifest head: ' + file);
  let tracked = 0, ignored = 0;
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (name.startsWith('.local/')) {
      if (!pinned?.files[name] || pinned.files[name].sha256 !== expected) throw new Error('Unverified ignored manifest entry: ' + name);
      ignored++;
    } else {
      if (hash(gitFile(commit, name)) !== expected) throw new Error('Exact commit/source mismatch: ' + commit + ' ' + name);
      tracked++;
    }
  }
  if (pinned && ignored !== 9) throw new Error('Source manifest must include all nine pinned binary hashes: ' + file);
  if (requireEmbeddedReceipt) verifyPropReceipt(manifest.propAssets, pinned, file);
  return { commit, manifestSha256: hash(fs.readFileSync(file)), trackedFilesVerifiedAgainstCommit: tracked, ignoredFilesVerifiedAgainstPinnedManifestAndDisk: ignored };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    if (!arg.startsWith('--')) throw new Error('Expected named options');
    const i = arg.indexOf('='); return i < 0 ? [arg.slice(2), true] : [arg.slice(2, i), arg.slice(i + 1)];
  }));
  if (!args.write || args.help) { console.log('Await root authorization. Then: node handoff/x51-curate-c8.cjs --write [--final-artifact=<exact-basename> --final-commit=<40-char-SHA> [--final-ci=<handoff-summary-basename>]]\nOriginal/initial run directories and image selections are fixed; final is explicit, never latest/green-only.'); return; }
  for (const key of Object.keys(args)) if (!['write', 'final-artifact', 'final-commit', 'final-ci'].includes(key)) throw new Error('Unknown option ' + key);
  if (args.write !== true) throw new Error('--write is a bare flag');
  const finalRequested = args['final-artifact'] !== undefined || args['final-commit'] !== undefined || args['final-ci'] !== undefined;
  if (finalRequested && (typeof args['final-artifact'] !== 'string' || !/^[\w.-]+$/.test(args['final-artifact']) || !/^[a-f0-9]{40}$/.test(args['final-commit'] || ''))) throw new Error('Final case requires exact --final-artifact basename and --final-commit');
  if (args['final-ci'] !== undefined && (typeof args['final-ci'] !== 'string' || !/^[\w.-]+\.json$/.test(args['final-ci']))) throw new Error('Expected final CI summary JSON basename');
  if (fs.existsSync(out)) throw new Error('Preserve existing evidence directory: ' + out);
  const pending = [], names = new Set(), sourceChecks = [], outcomes = [];
  function queue(bytes, name, metadata = {}) {
    relative(name); if (names.has(name)) throw new Error('Duplicate archive file ' + name); names.add(name);
    pending.push({ bytes, name, metadata });
  }
  function copy(file, name) { queue(fs.readFileSync(file), name, { source: path.relative(fixture, file).replaceAll('\\', '/') }); }
  function json(value, name) { queue(Buffer.from(JSON.stringify(value, null, 2) + '\n'), name, { generatedSummary: true }); }
  function gzip(file, name) {
    const raw = fs.readFileSync(file), bytes = zlib.gzipSync(raw, { level: 9 });
    if (hash(zlib.gunzipSync(bytes)) !== hash(raw)) throw new Error('Lossless gzip verification failed');
    queue(bytes, name, { source: path.relative(fixture, file).replaceAll('\\', '/'), originalBytes: raw.length, originalSha256: hash(raw), losslessGzip: true });
  }
  const pinned = verifyPinnedProps(integratedCommit);
  json(pinned, 'source-map/pinned-prop-bytes.json');
  queue(gitFile(integratedCommit, 'prop-assets.json'), 'source-map/prop-assets.json', { exactCommit: integratedCommit });
  const specs = [
    { label: 'original-c8', artifact: 'gpu-town-c8', report: 'render-report.json', commit: originalCommit, baseline: true },
    { label: 'meadow', artifact: 'gpu-meadow-c7-c8', report: 'meadow-report.json', commit: originalCommit, driver: 'x51-c7-meadow-gpu.cjs' },
    { label: 'ao', artifact: 'gpu-ao-c8-v1', report: 'ao-report.json', commit: originalCommit, driver: 'x51-c8-ao-gpu.cjs' },
    { label: 'integrated', artifact: 'gpu-props-c8-v1', report: 'render-report.json', commit: integratedCommit, baseline: true, props: true },
    { label: 'targeted', artifact: 'gpu-props-c8-integration-v1', report: 'integration-report.json', commit: integratedCommit, driver: 'x51-c8-props-integration-gpu.cjs', separatePropManifest: true },
    { label: 'shutter-cause', artifact: 'gpu-shutter-c8-cause-v1', report: 'shutter-report.json', commit: integratedCommit, driver: 'x51-c8-shutter-cause-gpu.cjs', separatePropManifest: true },
    { label: 'shutter-grade-driver-failed', artifact: 'gpu-shutter-c8-grade-v1', report: 'grade-report.json', commit: integratedCommit, driver: 'x51-c8-shutter-grade-gpu.cjs', separatePropManifest: true, failedDriver: true },
    { label: 'shutter-grade', artifact: 'gpu-shutter-c8-grade-v2', report: 'grade-report.json', commit: integratedCommit, driver: 'x51-c8-shutter-grade-gpu-v2.cjs', separatePropManifest: true },
  ];
  if (finalRequested) specs.push({ label: 'final', artifact: args['final-artifact'], report: 'render-report.json', commit: args['final-commit'], baseline: true, props: true });
  const baselineImages = ['01-station-street.jpg', '02-station-port.jpg', '03-island-aerial.jpg', '04-shop-interior.jpg', '16-city-context.jpg', '18-town-shop-balconies.jpg', '19-town-rear-stairs.jpg', 'walking-third.jpg', 'walking-first.jpg'];
  for (const spec of specs) {
    const run = path.join(fixture, 'artifacts', spec.artifact), report = read(path.join(run, spec.report));
    // Completion is an archival boundary; false render/transport/behavior outcomes remain evidence.
    if (report.stage !== 'complete') throw new Error('Capture not finalized: ' + spec.artifact);
    const config = read(path.join(run, 'run-config.json'));
    const specPinned = spec.props || spec.separatePropManifest ? (spec.commit === integratedCommit ? pinned : verifyPinnedProps(spec.commit)) : null;
    const checked = verifyManifest(path.join(run, 'source-manifest.json'), spec.commit, specPinned, spec.props === true);
    if (spec.label === 'final') {
      json(specPinned, 'source-map/final-pinned-prop-bytes.json');
      queue(gitFile(spec.commit, 'prop-assets.json'), 'source-map/final-prop-assets.json', { exactCommit: spec.commit });
    }
    if (spec.separatePropManifest) {
      const assets = read(path.join(run, 'prop-assets-manifest.json'));
      verifyPropReceipt(assets, specPinned, spec.artifact + '/prop-assets-manifest.json');
      checked.separatePropManifestFilesVerified = assets.files.length;
      copy(path.join(run, 'prop-assets-manifest.json'), spec.label + '/prop-assets-manifest.json');
    }
    if (config.sourceManifest && config.sourceManifest.sha256 !== checked.manifestSha256) throw new Error('Config/source-manifest mismatch: ' + spec.artifact);
    if (report.headAfter !== undefined && report.headAfter !== spec.commit) throw new Error('headAfter mismatch: ' + spec.artifact);
    sourceChecks.push({ label: spec.label, artifact: spec.artifact, ...checked });
    for (const file of ['source-manifest.json', 'run-config.json', 'process.json', 'electron.log']) copy(path.join(run, file), spec.label + '/' + file);
    gzip(path.join(run, spec.report), spec.label + '/' + spec.report + '.gz');
    if (spec.failedDriver) {
      if (report.captures?.length !== 0 || !String(report.failure).includes('glError')) throw new Error('Grade v1 differs from the documented zero-capture driver failure; re-review evidence');
      for (const file of ['source-manifest.json', 'prop-assets-manifest.json', 'run-config.json']) gzip(path.join(run, file), spec.label + '/' + file + '.gz');
    }
    if (spec.driver) {
      const driver = path.join(__dirname, spec.driver);
      if (hash(fs.readFileSync(driver)) !== config.driverSha256) throw new Error('Diagnostic driver mismatch: ' + spec.driver);
      copy(driver, spec.label + '/' + spec.driver);
    }
    let images;
    if (spec.failedDriver) images = [];
    else if (spec.baseline) images = [...baselineImages, ...(spec.props ? ['23-service-corner.jpg', '24-laundry-details.jpg', '23-service-corner.png', '24-laundry-details.png'] : [])];
    else if (spec.label === 'meadow') images = ['19-rear-reference-capture.jpg', '20-rear-eye-capture.jpg', '21-front-eye-capture.jpg', '22-low-house-entry-capture.jpg', '20-rear-eye-capture.png', '21-front-eye-capture.png'];
    else if (spec.label === 'ao') images = ['20-rear-eye', '21-front-eye', 'station-street'].flatMap(view => ['on', 'off'].flatMap(state => [view + '-ao-' + state + '-capture-2.jpg', ...(view === 'station-street' ? [] : [view + '-ao-' + state + '-capture-2.png'])]));
    else if (spec.label === 'shutter-cause') images = ['00-original', '01-normal-off', '03-shadow-off', '05-basic-map-only', '07-service-candidate', '08-laundry-candidate'].map(name => name + '-capture-2.jpg');
    else if (spec.label === 'shutter-grade') images = ['00-contrast-original', '01-contrast-neutral', '02-contrast-restored'].flatMap(name => [name + '-capture-2.jpg', name + '-capture-2.png']);
    else images = ['service-corner', 'service-corner-shutter-ao-off', 'laundry-details', 'laundry-details-world-ao-off'].flatMap(name => [name + '-capture-2.jpg', name + '-capture-2.png']);
    for (const file of images) {
      if (!/\.(?:jpg|png)$/.test(file)) throw new Error('Only original PNG/JPG screenshots are selected: ' + file);
      const record = report.captures?.find(c => typeof c === 'object' && c.name + '.png' === file);
      if (record?.pngSha256 && hash(fs.readFileSync(path.join(run, file))) !== record.pngSha256) throw new Error('PNG differs from capture-time report hash: ' + file);
      copy(path.join(run, file), spec.label + '/' + file);
    }
    for (const file of fs.readdirSync(run).filter(name => /^frame-samples.*\.json$/.test(name) || /^frames-(?:station-street|island-aerial)-(?:A1|B|A2)\.json$/.test(name))) copy(path.join(run, file), spec.label + '/' + file);
    const summary = { sourceCommit: spec.commit, sourceVerification: checked,
      ...pick(report, ['stage', 'completedAt', 'ok', 'renderOk', 'transportClean', 'versions', 'performance', 'sourceUnchanged', 'driverUnchanged', 'changedSourceFiles', 'restore', 'restoreFailure', 'assetsUnchanged', 'assetFiles', 'integration', 'renderedSubjects', 'walkTransitions', 'walkingValidation', 'behaviorValidation', 'lookValidation', 'streetscapeCaptures', 'townDetailCaptures', 'networkFailures', 'failedRequestTiming', 'failedRequestTimingNote', 'httpErrors', 'exceptions', 'failure']),
      strictExpectedProcessExitFromReport: report.ok === true ? 0 : 1,
      exitEvidence: 'Expected from driver/report ok, not a persisted OS process exit observation. Preserve console/runner exit separately.',
      views: report.views?.map(({ scene, ...view }) => view),
      initial: report.initial,
      firstReady: report.firstReady ? pick(report.firstReady, ['revision', 'dimensions', 'renderer', 'timing', 'quality', 'city', 'texturedProps']) : undefined,
      selectedImages: images,
      captures: Array.isArray(report.captures) ? report.captures.filter(c => typeof c === 'object' && images.some(name => name === c.name + '.jpg' || name === c.name + '.png')) : undefined };
    if (spec.label === 'ao') {
      summary.causalPairs = ['20-rear-eye', '21-front-eye', 'station-street'].map(view => {
        const on = report.captures.find(c => c.name === view + '-ao-on-capture-2'), off = report.captures.find(c => c.name === view + '-ao-off-capture-2');
        if (!on || !off) throw new Error('Missing predetermined AO pair: ' + view);
        const fields = ['camera', 'lights', 'time', 'stationTime', 'toon', 'params', 'quality', 'depth', 'dimensions'];
        return { view, onAO: on.ao, offAO: off.ao, equalFields: Object.fromEntries(fields.map(k => [k, JSON.stringify(on[k]) === JSON.stringify(off[k])])), firstSecondPNGEqual: Object.fromEntries(['on', 'off'].map(state => { const one = report.captures.find(c => c.name === view + '-ao-' + state + '-capture-1'), two = report.captures.find(c => c.name === view + '-ao-' + state + '-capture-2'); return [state, one?.pngSha256 === two?.pngSha256]; })) };
      });
    }
    if (spec.label === 'integrated' || spec.label === 'targeted') summary.visualAssessment = 'Initial 5cf3 integration is not visually accepted: dark shed doors and clipped detail framing were observed by the root reviewer. Loaded textures/renderOk do not establish style or framing acceptance. Original images and diagnostic variants are retained.';
    if (spec.label === 'shutter-cause') summary.diagnosticBoundary = 'Basic map-only is an unlit causal diagnostic, not a material fix or accepted scene variant. The root reviewer observed that normal-off and receiveShadow-off separately remained dark, while Basic revealed the source texture; actual light and white material-color state were inspected. Candidate views test framing only. Full report retains all 9 states / 27 captures including restored states; this archive selects the predetermined second-frame JPGs.';
    if (spec.label === 'shutter-grade') summary.diagnosticBoundary = 'Causal contrast 1.05 -> 1 -> 1.05 experiment on the original material and lighting. The hypothesis is that post-linear contrast can clip dark source signal; no conclusion is inferred from successful loading or renderOk. Selected original/neutral/restored second-frame images and full linear readback/capture records are preserved. Neutral contrast is a diagnostic state, not an authorized global grade fix or visual acceptance.';
    if (spec.failedDriver) summary.diagnosticBoundary = 'Grade v1 failed in the external host while reading nonexistent shot.renderer.glError, before saving any capture. This is a diagnostic-driver interface failure, not evidence that the scene or contrast hypothesis failed. Preserve original report flags, TypeError, restoration and source/assets checks. The unchanged v1 driver is hash-verified separately from the v2 interface repair; no failure artifacts were overwritten.';
    json(summary, spec.label + '/measurements.json');
    outcomes.push({ label: spec.label, artifact: spec.artifact, ...pick(report, ['stage', 'ok', 'renderOk', 'transportClean', 'sourceUnchanged', 'driverUnchanged']), strictExpectedExit: summary.strictExpectedProcessExitFromReport });
  }

  // Transport ran before the source commit, on dirty resource-layer inputs. Do not relabel recorded HEAD as a clean source state.
  const sourceInventory = JSON.parse(gitFile(integratedCommit, 'source-files.json'));
  for (const [label, artifact] of [['initial', 'asset-transport-props-c8'], ['entry-fixed', 'asset-transport-props-c8-entry-fixed']]) {
    const run = path.join(fixture, 'artifacts', artifact), config = read(path.join(run, 'run-config.json'));
    const sourceMap = { recordedHead: config.head, matchingCommittedInputs: integratedCommit, cleanRecordedHeadClaimed: false, files: [] };
    for (const [name, sha256] of Object.entries(config.scripts)) {
      const normalized = path.posix.normalize('scripts/' + name);
      if (normalized.startsWith('.local/')) {
        const record = sourceInventory.find(v => v.project === 'petalwake' && normalized === '.local/petalwake-25443cef0eba802052d9ef24c94ba3c4157b6f2e/' + v.path);
        if (!record || record.sha256 !== sha256 || hash(fs.readFileSync(path.join(fixture, normalized))) !== sha256) throw new Error('Transport upstream source mismatch: ' + name);
        sourceMap.files.push({ file: normalized, sha256, verifiedBy: 'Exact-commit source-files.json and actual local bytes; ignored file never git show' });
      } else if (label === 'initial' && name === 'diagnose-asset-transport.cjs') {
        const probe = read(path.join(__dirname, 'x51-c8-transport-entry-probe/conclusion.json'));
        const preparation = read(path.join(__dirname, 'x51-prop-preparation-checks.json'));
        if (probe.sourceSha256AtProbe !== sha256 || !preparation.frozenSourceFiles.some(v => v.file === normalized && v.sha256 === sha256)) throw new Error('Old transport entry hash lacks immutable audit corroboration');
        sourceMap.files.push({ file: normalized, sha256, verifiedBy: 'Pre-commit frozen CPU check and entry-probe hash records only', exactGitBlobVerified: false, note: 'Do not claim clean 5463714 or byte-identical final driver. No old source reconstruction.' });
      } else {
        if (hash(gitFile(integratedCommit, normalized)) !== sha256) throw new Error('Transport dirty input differs from eventual commit: ' + normalized);
        sourceMap.files.push({ file: normalized, sha256, verifiedBy: integratedCommit });
      }
    }
    for (const t of config.targets) {
      const actual = fs.readFileSync(path.join(fixture, relative(t.file)));
      if (actual.length !== t.bytes || hash(actual) !== t.sha256) throw new Error('Transport target bytes changed: ' + t.name);
      if (t.file.startsWith('.local/textured-props/') && (!pinned.files[t.file] || t.sha256 !== pinned.files[t.file].sha256)) throw new Error('Transport prop differs from pinned source');
    }
    for (const file of ['run-config.json', 'process.json', 'electron.log']) copy(path.join(run, file), 'transport/' + label + '/' + file);
    json(sourceMap, 'transport/' + label + '/source-map.json');
    if (label === 'initial') {
      if (fs.existsSync(path.join(run, 'asset-transport-report.json'))) throw new Error('Initial run unexpectedly has a report; re-review provenance');
      json({ reportPresent: false, archivedFailure: true, rootReportedExitHex: '0x80000003', rootReportedExitSource: 'Parent task handoff; artifact itself has no persisted native exit record', javascriptEntryGuardDefectConfirmed: true, nativeExitCauseEstablished: false, note: 'Blank original log preserved; no rendering/transport success inferred. Probe demonstrates entry semantics, not native exit causality.' }, 'transport/initial/measurements.json');
    } else {
      const r = read(path.join(run, 'asset-transport-report.json'));
      if (r.stage !== 'complete') throw new Error('Transport report incomplete');
      gzip(path.join(run, 'asset-transport-report.json'), 'transport/entry-fixed/asset-transport-report.json.gz');
      const summary = { ...pick(r, ['stage', 'ok', 'bytesIntegrity', 'transportClean', 'inputsUnchanged', 'exceptions', 'httpErrors', 'missingTerminal', 'failure']), expected: r.config.expectedCaseCount, count: r.cases.length,
        bytesPass: r.cases.filter(c => c.bytesIntegrity).length, transportPass: r.cases.filter(c => c.transportClean).length,
        methods: Object.fromEntries(r.config.methods.map(method => { const rows = r.cases.filter(c => c.method === method); return [method, { count: rows.length, bytesPass: rows.filter(c => c.bytesIntegrity).length, transportPass: rows.filter(c => c.transportClean).length }]; })),
        networkFailures: r.networkFailures, failingCases: r.cases.filter(c => !c.transportClean || !c.bytesIntegrity), strictExpectedExit: r.ok ? 0 : 1,
        note: 'No retries or relaxed failure rules; all byte success can coexist with failed transport terminal events.' };
      json(summary, 'transport/entry-fixed/measurements.json'); outcomes.push({ label: 'transport-entry-fixed', ...pick(summary, ['ok', 'bytesIntegrity', 'transportClean', 'count', 'bytesPass', 'transportPass', 'strictExpectedExit']) });
    }
  }
  for (const file of ['conclusion.json', 'entry-evidence.json', 'entry.cjs', 'launch.json', 'process-result.json']) copy(path.join(__dirname, 'x51-c8-transport-entry-probe', file), 'transport/entry-probe/' + file);
  copy(path.join(__dirname, 'x51-c8-transport-summary.json'), 'transport/root-summary.json');

  const cpuNames = ['x51-textured-props-cpu-audit.json', 'x51-textured-props-cpu-driver.mjs', 'x51-textured-props-cpu-result.jsonl', 'x51-prop-preparation-checks.json', 'x51-check-prop-preparation.cjs', 'x51-c8-ao-plane-fixed-proof.json', 'x51-c8-ao-plane-fixed-proof.mjs', 'x51-c8-shutter-normal-cpu-pixels.json'];
  const cpuAudit = read(path.join(__dirname, cpuNames[0]));
  const cpuSourceMap = Object.entries(cpuAudit.sourceHashes).map(([file, sha256]) => {
    const committedBytes = gitFile(integratedCommit, file), committedSha256 = hash(committedBytes);
    const row = { file, auditedSha256: sha256, comparisonCommit: integratedCommit, committedSha256, exactCommitMatch: sha256 === committedSha256 };
    if (!row.exactCommitMatch && file === 'src/textured-props.js') {
      const token = 'aoMap: arm, ', source = committedBytes.toString('utf8');
      if (source.split(token).length === 2) {
        const reversedSha256 = hash(Buffer.from(source.replace(token, '')));
        row.singleTokenCheck = { tokenRemovedFromCommittedSourceInMemory: token, reversedSha256, matchesHistoricalAudit: reversedSha256 === sha256 };
        if (reversedSha256 === sha256) row.exactDifference = 'Historical CPU source lacked only the shutter aoMap: arm binding; committed GPU source has it. No historical file was rewritten or whole-commit CPU success inferred.';
      }
    }
    return row;
  });
  json({ scope: 'Historical pre-commit CPU audit, not a source-manifest or final material verification. A source mismatch is preserved explicitly, never relabeled as a clean commit pass.', files: cpuSourceMap }, 'source-map/early-cpu-audit.json');
  if (hash(fs.readFileSync(path.join(__dirname, cpuNames[1]))) !== cpuAudit.evidenceHashes.driver || hash(fs.readFileSync(path.join(__dirname, cpuNames[2]))) !== cpuAudit.evidenceHashes.result) throw new Error('CPU driver/result audit hash mismatch');
  for (const file of cpuNames) copy(path.join(__dirname, file), 'cpu/' + file);
  const diagnosis = read(path.join(__dirname, 'x51-props-v1-readonly-diagnosis.json'));
  for (const [file, sha] of Object.entries(diagnosis.sourceHashes)) if (hash(gitFile(integratedCommit, file)) !== sha) throw new Error('Read-only props diagnosis source mismatch: ' + file);
  for (const file of ['x51-c8-ao-gpu-v1-readback.json', 'x51-props-v1-readonly-diagnosis.json', 'x51-c8-props-integration-v1-analysis.json', 'x51-c8-shutter-cause-v1-analysis.json', 'x51-c8-shutter-grade-v2-analysis.json']) copy(path.join(__dirname, file), 'analysis/' + file);
  const ci = [];
  for (const [label, file, commit] of [['original-c8', 'x51-c8-ci-summary.json', originalCommit], ['initial-props', 'x51-c8-props-ci-summary.json', integratedCommit], ...(args['final-ci'] ? [['final', args['final-ci'], args['final-commit']]] : [])]) {
    const summary = read(path.join(__dirname, file));
    if (summary.head !== commit) throw new Error('CI summary belongs to another source: ' + file);
    copy(path.join(__dirname, file), 'ci/' + label + '.json');
    ci.push({ label, ...pick(summary, ['head', 'job', 'url', 'result', 'completedAt', 'tests', 'passed', 'types', 'builds', 'allExitZero']) });
  }
  copy(__filename, 'curate-c8.cjs');
  json({ createdAt: new Date().toISOString(), sourceChecks, outcomes, ci, finalCI: args['final-ci'] ? 'Explicit final-head CI summary included and head verified' : 'No final-head CI summary archived; original/initial CI must not be attributed to a later source commit',
    method: 'Predetermined C8 original, meadow, AO, integrated and targeted runs. Source manifests verified against each exact commit. Nine ignored asset files verified against the integrated commit prop-assets.json and actual byte size/MD5/SHA; never git show ignored files. Images are copied without decoding, resizing or recompression. Full reports are lossless gzip with original hashes. AO presents predetermined capture-2, preserving every capture record in the full report. Failure runs and transport failures are retained.',
    limitations: 'Not whole-world/style acceptance. AO causal stills do not establish performance. Targeted two-view sequential AO A-B-A frame samples support only that bounded experiment, not universal FPS or a release benchmark. The early transport config HEAD records a dirty working tree, not a clean 5463714 source claim. Old driver is supported by frozen hash records only. An entry-guard defect is proved; the native 0x80000003 cause is not. CPU texture stubs and metadata do not prove visibility. Absolute paths inside original reports remain original forensic data and may require the original workspace to replay. No asset originals, runtime caches or user profiles are archived.',
    imagesSelection: 'No best-of selection: fixed named baseline views, AO second capture of both states, explicitly named targeted views. Omitted warmup/first AO image pixels remain in original local artifact directories; all their report records remain archived.' }, 'summary.json');

  // Every read, exact-source verification and gzip check finishes before creating the output.
  fs.mkdirSync(out, { recursive: true });
  const files = [];
  for (const item of pending) {
    const target = path.join(out, item.name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, item.bytes, { flag: 'wx' });
    files.push({ file: item.name, bytes: item.bytes.length, sha256: hash(item.bytes), ...item.metadata });
  }
  fs.writeFileSync(path.join(out, 'provenance.json'), JSON.stringify({ createdAt: new Date().toISOString(), files, countExcludesThisInventory: true }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ out, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), outcomes }, null, 2));
}
if (require.main === module) { try { main(); } catch (error) { console.error(error); process.exitCode = 1; } }
