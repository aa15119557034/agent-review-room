// Independent Electron launcher; no application build, install or credentials needed.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');

const fixture = path.resolve(__dirname, '..');
const originals = {
  petalwake: 'petalwake-25443cef0eba802052d9ef24c94ba3c4157b6f2e',
  sakuragaoka: 'sakuragaoka-4112f57208b7e29998344ca71fef74202c2b2bdd',
};
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

function createStaticServer(root = fixture) {
  return http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400).end(); return; }
    let base = root, relative = pathname;
    for (const [name, directory] of Object.entries(originals)) {
      if (pathname.startsWith(`/original/${name}/`)) {
        base = path.join(root, '.local', directory);
        relative = pathname.slice(`/original/${name}/`.length);
      }
    }
    if (pathname.startsWith('/assets/')) {
      base = path.join(root, '.local', originals.petalwake, 'assets');
      relative = pathname.slice('/assets/'.length);
    }
    if (base === root && (pathname.startsWith('/.local/') || pathname.startsWith('/artifacts/'))) { res.writeHead(403).end(); return; }
    const file = path.resolve(base, relative.replace(/^\/+/, '') || 'index.html');
    const rel = path.relative(base, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403).end(); return; }
    let resolved = file;
    try {
      if (fs.statSync(resolved).isDirectory() && fs.existsSync(path.join(resolved, 'index.html'))) resolved = path.join(resolved, 'index.html');
      const real = fs.realpathSync(resolved), realBase = fs.realpathSync(base);
      const realRelative = path.relative(realBase, real);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) { res.writeHead(403).end(); return; }
      const stat = fs.statSync(real);
      if (stat.isDirectory()) {
        // Petalwake's _loadStand probes the model directory listing, matching
        // its original Python SimpleHTTPRequestHandler development server.
        const escape = text => text.replace(/[&<>\"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
        const entries = fs.readdirSync(real).filter(name => !name.startsWith('.')).sort();
        const html = '<!doctype html><title>Directory listing</title><ul>' + entries.map(name => `<li><a href="${encodeURIComponent(name)}">${escape(name)}</a></li>`).join('') + '</ul>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : html); return;
      }
      if (!stat.isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': mime[path.extname(real)] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
    } catch { res.writeHead(404).end(); }
  });
}

function cleanEnvironment(runtime) {
  const env = {};
  for (const name of ['SystemRoot', 'windir', 'SystemDrive', 'PATH', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) {
    const key = Object.keys(process.env).find(k => k.toLowerCase() === name.toLowerCase());
    if (key) env[key] = process.env[key];
  }
  for (const [name, directory] of Object.entries({ LOCALAPPDATA: 'local', APPDATA: 'roaming', USERPROFILE: 'profile', TEMP: 'temp', TMP: 'temp' })) {
    env[name] = path.join(runtime, directory);
    fs.mkdirSync(env[name], { recursive: true });
  }
  // ELECTRON_RUN_AS_NODE and application secrets are intentionally never inherited.
  return env;
}

function numberArg(args, name, fallback, minimum = 0) {
  const value = Number(args[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`Invalid --${name}`);
  return value;
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    if (!arg.startsWith('--')) throw new Error(`Expected --option, got ${arg}`);
    const split = arg.indexOf('=');
    return split < 0 ? [arg.slice(2), true] : [arg.slice(2, split), arg.slice(split + 1)];
  }));
  if (args.help) {
    console.log('node scripts/baseline.cjs --scene=petalwake|sakuragaoka|combined --electron=<executable> [--output=<directory>] [--preview] [--stills] [--video-ms=8200] [--sample-ms=15000] [--warmup-ms=5000] [--timeout-ms=180000] [--query=q=high] [--proxy=http://127.0.0.1:7897]');
    return;
  }
  const allowed = new Set(['scene', 'electron', 'output', 'preview', 'stills', 'video-ms', 'sample-ms', 'warmup-ms', 'timeout-ms', 'query', 'proxy', 'width', 'height']);
  for (const name of Object.keys(args)) if (!allowed.has(name)) throw new Error(`Unknown --${name}`);
  const scene = args.scene || 'combined';
  if (![...Object.keys(originals), 'combined'].includes(scene)) throw new Error('Unknown scene');
  if (!args.electron || !fs.existsSync(args.electron)) throw new Error('--electron must name an existing Electron executable');
  const source = scene === 'combined' ? fixture : path.join(fixture, '.local', originals[scene]);
  if (!fs.existsSync(path.join(source, 'index.html'))) throw new Error(`Missing ${source}/index.html`);
  const output = path.resolve(args.output || path.join(fixture, '.local', 'captures', `${scene}-${Date.now()}`));
  fs.mkdirSync(output, { recursive: true });
  const runtime = fs.mkdtempSync(path.join(output, 'runtime-'));
  const config = {
    scene, fixture, output, runtime, source,
    preview: args.preview === true,
    width: numberArg(args, 'width', 1440, 1), height: numberArg(args, 'height', 900, 1),
    sampleMs: numberArg(args, 'sample-ms', 15000, 1000),
    warmupMs: numberArg(args, 'warmup-ms', 5000),
    timeoutMs: numberArg(args, 'timeout-ms', 180000, 1000),
    videoMs: args.stills ? 0 : numberArg(args, 'video-ms', scene === 'combined' ? 8200 : 0),
    query: typeof args.query === 'string' ? args.query : '',
    proxy: typeof args.proxy === 'string' ? args.proxy : scene !== 'combined' ? 'http://127.0.0.1:7897' : '',
    startedAt: new Date().toISOString(),
    entrySha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(source, 'index.html'))).digest('hex'),
  };
  const configFile = path.join(runtime, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(output, 'run-config.json'), JSON.stringify(config, null, 2));
  const log = fs.openSync(path.join(output, 'electron.log'), 'w');
  const child = cp.spawn(path.resolve(args.electron), [path.join(__dirname, 'preview-host.cjs'), configFile], {
    cwd: fixture, env: cleanEnvironment(runtime), windowsHide: !config.preview,
    detached: config.preview, stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('spawn', () => {
    fs.writeFileSync(path.join(output, 'process.json'), JSON.stringify({ pid: child.pid, executable: path.resolve(args.electron), preview: config.preview }, null, 2));
    console.log(`${config.preview ? 'Preview' : 'Capture'} PID ${child.pid}; output ${output}`);
    if (config.preview) child.unref();
  });
  if (!config.preview) child.on('exit', (code, signal) => {
    console.log(`Electron exited ${code ?? signal}; report ${path.join(output, 'render-report.json')}`);
    process.exitCode = code ?? 1;
  });
}

module.exports = { createStaticServer, cleanEnvironment };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
