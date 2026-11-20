// Read-only CPU PNG comparison: no BrowserWindow, scene, renderer or GPU capture.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { cleanEnvironment } = require('./baseline.cjs');
const { pixelStats, diagnosticRegions } = require('./diagnose-surface.cjs');

function argumentsOf(argv) {
  const args = Object.fromEntries(argv.map(arg => {
    const split = arg.indexOf('=');
    if (!arg.startsWith('--')) throw new Error(`Expected --option: ${arg}`);
    return split < 0 ? [arg.slice(2), true] : [arg.slice(2, split), arg.slice(split + 1)];
  }));
  for (const key of Object.keys(args)) if (!['electron', 'before', 'after', 'view', 'help'].includes(key)) throw new Error(`Unknown --${key}`);
  return args;
}

function compare(args, nativeImage) {
  if (!['aerial', 'street'].includes(args.view)) throw new Error('--view=aerial|street is required');
  const read = name => {
    if (typeof args[name] !== 'string') throw new Error(`--${name}=<PNG> is required`);
    const source = path.resolve(args[name]), buffer = fs.readFileSync(source);
    if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`${name} is not PNG`);
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) throw new Error(`Cannot decode ${source}`);
    return { image, source: { path: source, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), ...image.getSize() } };
  };
  const before = read('before'), after = read('after');
  const names = diagnosticRegions.filter(region => region.name.startsWith(args.view === 'aerial' ? 'aerial-' : 'station-')).map(region => region.name);
  const a = pixelStats(before.image), b = pixelStats(after.image, before.image);
  return { before: before.source, after: after.source, method: 'CPU nativeImage PNG decode, Windows BGRA; display-encoded luma .2126R+.7152G+.0722B on 0..255, bright >=240. Hashes identify source only. Images/reports are never modified.', regions: b.filter(region => names.includes(region.name)).map(region => ({ before: a.find(item => item.name === region.name), after: region })) };
}

function main() {
  const args = argumentsOf(process.argv.slice(2));
  if (args.help) { console.log('node scripts/compare-surface-png.cjs --electron=<existing executable> --before=<PNG> --after=<PNG> --view=aerial|street'); return; }
  if (process.versions.electron) {
    const { app, nativeImage } = require('electron');
    app.disableHardwareAcceleration();
    try { console.log(JSON.stringify(compare(args, nativeImage))); app.exit(0); }
    catch (error) { console.error(error.stack || error); app.exit(1); }
    return;
  }
  if (typeof args.electron !== 'string' || !fs.statSync(args.electron).isFile()) throw new Error('--electron must name an existing executable');
  // Validate paths before launching Electron; decoding occurs before app.ready.
  for (const name of ['before', 'after']) if (typeof args[name] !== 'string' || !fs.statSync(args[name]).isFile()) throw new Error(`Invalid --${name}`);
  const tempRoot = path.resolve(os.tmpdir());
  const runtime = fs.mkdtempSync(path.join(tempRoot, 'world-png-compare-'));
  try {
    const result = cp.spawnSync(path.resolve(args.electron), [__filename, `--before=${path.resolve(args.before)}`, `--after=${path.resolve(args.after)}`, `--view=${args.view}`], { windowsHide: true, env: cleanEnvironment(runtime), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`PNG decoder exited ${result.status}: ${result.stderr}`);
    const report = JSON.parse(result.stdout.trim());
    console.log(JSON.stringify(report));
  } finally {
    const resolved = path.resolve(runtime);
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('world-png-compare-')) throw new Error('Unexpected temporary directory; refusing cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

try { main(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
