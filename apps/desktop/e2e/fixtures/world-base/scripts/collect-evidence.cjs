// Curate existing captures for review; never copy runtime profiles or upstream assets.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const captures = process.argv.slice(2);
if (captures.length < 3 || captures.length > 4) throw new Error('Usage: node scripts/collect-evidence.cjs <combined-dir> <petalwake-dir> <sakuragaoka-dir> [video-dir]');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = directory => JSON.parse(fs.readFileSync(path.join(directory, 'render-report.json'), 'utf8'));
const summary = report => ({
  completedAt: report.completedAt, ok: report.ok, renderOk: report.renderOk, transportClean: report.transportClean,
  dimensions: report.firstReady.dimensions, quality: report.firstReady.quality,
  gpu: report.firstReady.renderer.gpu, versions: report.versions,
  timing: { firstWebGLDrawMs: report.firstReady.timing.firstWebGLDrawMs, sceneReadyMs: report.firstReady.timing.sceneReadyMs,
    firstReadyFrameMs: report.firstReady.timing.firstReadyFrameMs, navigationMs: report.firstReady.timing.navigation.duration },
  performance: report.performance, exceptions: report.exceptions, networkFailures: report.networkFailures,
  failedRequestTiming: report.failedRequestTiming,
});
const [combinedDir, petalDir, stationDir] = captures.map(directory => path.resolve(root, directory));
const videoDir = captures[3] ? path.resolve(root, captures[3]) : combinedDir;
const combined = read(combinedDir);
if (!combined.completedAt || !combined.renderOk) throw new Error('Combined render/behavior validation has not passed. Retain raw captures and repair first.');
const videoReport = read(videoDir);
const videoCheck = JSON.parse(fs.readFileSync(path.join(videoDir, 'video-verification.json'), 'utf8'));
if (!videoCheck.ok || videoCheck.file.sha256 !== hash(path.join(videoDir, 'world.webm'))) throw new Error('Video decode verification is missing or belongs to a different file');
const videoSource = JSON.parse(fs.readFileSync(path.join(videoDir, 'source-manifest.json'), 'utf8'));
for (const [file, sha256] of Object.entries(videoSource.files)) {
  if (hash(path.join(root, file)) !== sha256) throw new Error(`Scene source changed after video capture: ${file}`);
}
const out = path.join(root, 'evidence');
fs.mkdirSync(out, { recursive: true });
const media = [];
function copy(source, destination) {
  const target = path.join(out, destination);
  fs.copyFileSync(source, target);
  media.push({ file: destination, bytes: fs.statSync(target).size, sha256: hash(target) });
}
for (const capture of combined.captureDetails) copy(path.join(combinedDir, capture.jpeg), capture.jpeg);
copy(path.join(videoDir, 'world.webm'), 'world.webm');
copy(path.join(videoDir, 'source-manifest.json'), 'video-source-manifest.json');
copy(path.join(videoDir, 'video-container-timeline.json'), 'video-container-timeline.json');
copy(path.join(videoDir, 'video-source-timeline.json'), 'video-source-timeline.json');
for (const name of fs.readdirSync(videoDir).filter(name => /^video-frame-\d+\.jpg$/.test(name))) copy(path.join(videoDir, name), name);
copy(path.join(petalDir, '00-default.png'), 'original-petalwake.png');
copy(path.join(stationDir, '00-default.png'), 'original-sakuragaoka.png');
for (const name of fs.readdirSync(combinedDir).filter(name => /^frame-samples.*\.json$/.test(name))) copy(path.join(combinedDir, name), name);
const report = {
  baselines: { petalwake: summary(read(petalDir)), sakuragaoka: summary(read(stationDir)) },
  combined: { ...summary(combined), views: combined.views.map(({ scene, ...view }) => view),
    behaviorValidation: combined.behaviorValidation, walkingValidation: combined.walkingValidation,
    lookValidation: combined.lookValidation, video: { ...videoReport.video, captureCompletedAt: videoReport.completedAt,
      captureRenderOk: videoReport.renderOk, captureTransportClean: videoReport.transportClean },
    videoVerification: { ok: videoCheck.ok, method: videoCheck.method, file: videoCheck.file,
      container: videoCheck.container, sourceAlignment: videoCheck.sourceAlignment, decode: videoCheck.decode } },
  artifacts: media,
};
fs.writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
const sourceFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else sourceFiles.push({ path: path.relative(root, file).replaceAll('\\', '/'), sha256: hash(file) });
  }
}
for (const directory of ['src', 'upstream']) walk(path.join(root, directory));
for (const file of ['index.html', 'package.json']) sourceFiles.push({ path: file, sha256: hash(path.join(root, file)) });
const provenance = { computedAt: new Date().toISOString(), captureCompletedAt: combined.completedAt,
  note: 'Source hashes computed after capture. Scene source was not edited between this capture and this snapshot.',
  baseCommit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sources: JSON.parse(fs.readFileSync(path.join(root, 'sources.json'), 'utf8')), files: sourceFiles };
fs.writeFileSync(path.join(out, 'source-state.json'), JSON.stringify(provenance, null, 2) + '\n');
const originalFiles = JSON.parse(fs.readFileSync(path.join(root, 'source-files.json'), 'utf8'));
let patches = '';
for (const file of originalFiles.filter(file => file.path.startsWith('src/'))) {
  const adapted = path.join('upstream', file.project, file.path);
  if (!fs.existsSync(path.join(root, adapted)) || hash(path.join(root, adapted)) === file.sha256) continue;
  const original = path.join('.local', `${file.project}-${provenance.sources[file.project].commit}`, file.path);
  const diff = cp.spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-ext-diff', '--', original, adapted], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (diff.error || diff.status > 1) throw diff.error || new Error(diff.stderr);
  patches += diff.stdout;
}
fs.writeFileSync(path.join(out, 'upstream-changes.patch'), patches);
console.log(`Curated ${media.length} artifacts and measurement/source reports in evidence/`);
