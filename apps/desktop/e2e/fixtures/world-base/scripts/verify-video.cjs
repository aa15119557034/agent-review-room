// Decode an existing capture in an isolated Electron window. Does not load the
// 3D scene or re-encode/edit the input video. Produces JSON and decoded JPEG samples.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function inspectWebm(buffer) {
  const frames = [];
  let timeScaleNs = 1000000;
  const vint = (position, keepMarker = false) => {
    const first = buffer[position]; let length = 1, mask = 128;
    while (length <= 8 && !(first & mask)) { mask >>= 1; length++; }
    if (length > 8 || position + length > buffer.length) throw new Error('Invalid WebM VINT');
    let value = keepMarker ? first : first & (mask - 1), unknown = !keepMarker && value === mask - 1;
    for (let index = 1; index < length; index++) { value = value * 256 + buffer[position + index]; unknown = unknown && buffer[position + index] === 255; }
    return { value, length, unknown };
  };
  const uint = (start, end) => { let value = 0; for (let index = start; index < end; index++) value = value * 256 + buffer[index]; return value; };
  const parse = (start, end, clusterTime = 0) => {
    let position = start;
    while (position < end) {
      const id = vint(position, true); position += id.length;
      const size = vint(position); position += size.length;
      const childEnd = size.unknown ? end : position + size.value;
      if (childEnd > end) throw new Error('WebM element extends beyond its parent');
      if (id.value === 0x2ad7b1) timeScaleNs = uint(position, childEnd);
      else if (id.value === 0xe7) clusterTime = uint(position, childEnd);
      else if (id.value === 0xa3 || id.value === 0xa1) {
        const track = vint(position), flags = buffer[position + track.length + 2];
        frames.push({ time: (clusterTime + buffer.readInt16BE(position + track.length)) * timeScaleNs / 1e9, track: track.value, keyframe: Boolean(flags & 128), lacing: (flags >> 1) & 3, bytes: childEnd - position });
      } else if ([0x18538067, 0x1f43b675, 0x1549a966, 0xa0].includes(id.value)) parse(position, childEnd, id.value === 0x1f43b675 ? 0 : clusterTime);
      position = childEnd;
    }
  };
  parse(0, buffer.length);
  const gaps = frames.slice(1).map((frame, index) => ({ from: frames[index].time, to: frame.time, seconds: frame.time - frames[index].time }));
  const maximumGapSeconds = Math.max(0, ...gaps.map(gap => gap.seconds));
  return { method: 'Read-only EBML SimpleBlock/Block timestamps plus Cluster Timecode for this video-only, unlaced WebM.', timeScaleNs, frames, maximumGapSeconds, gapsOver120ms: gaps.filter(gap => gap.seconds > .12), ok: frames.length > 0 && new Set(frames.map(frame => frame.track)).size === 1 && frames.every(frame => frame.lacing === 0) && maximumGapSeconds <= .12 };
}

async function decodeVideo(base64) {
  const video = document.querySelector('video'), canvas = document.querySelector('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
  if (typeof video.requestVideoFrameCallback !== 'function') throw new Error('requestVideoFrameCallback is required');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Video metadata timeout')), 15000);
      video.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(Error('Video metadata decode error: ' + video.error?.message)); };
      video.src = objectUrl; video.load();
    });
    const metadata = { width: video.videoWidth, height: video.videoHeight, initialDuration: Number.isFinite(video.duration) ? video.duration : String(video.duration) };
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Sequential verification requires a finite metadata duration; no seek is used');
    if (!metadata.width || !metadata.height) throw new Error('Decoder returned empty dimensions');
    canvas.width = metadata.width; canvas.height = metadata.height;
    const targets = [.125, .375, .625, .875, .97].map(fraction => duration * fraction);
    const frames = [], timeline = [], hashes = [];
    let sampleIndex = 0, callbackId;
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); video.pause(); video.cancelVideoFrameCallback(callbackId); };
      const fail = error => { cleanup(); reject(error); };
      const timer = setTimeout(() => fail(Error('Sequential video playback timed out')), (duration + 15) * 1000);
      video.onerror = () => fail(Error('Video decode error: ' + video.error?.message));
      video.onended = () => { cleanup(); resolve(); };
      const onFrame = (_now, meta) => {
        callbackId = video.requestVideoFrameCallback(onFrame);
        timeline.push({ mediaTime: meta.mediaTime, presentedFrames: meta.presentedFrames, expectedDisplayTime: meta.expectedDisplayTime });
        try {
          while (sampleIndex < targets.length && meta.mediaTime >= targets[sampleIndex]) {
            const requestedTime = targets[sampleIndex++];
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let sum = 0, nonBlack = 0, samples = 0;
            for (let y = Math.floor(canvas.height * .15); y < canvas.height * .85; y += 4) {
              for (let x = Math.floor(canvas.width * .15); x < canvas.width * .85; x += 4) {
                const offset = (y * canvas.width + x) * 4;
                const mean = (rgba[offset] + rgba[offset + 1] + rgba[offset + 2]) / 3;
                sum += mean; nonBlack += Number(mean > 8); samples++;
              }
            }
            const meanRgb = sum / samples, nonBlackFraction = nonBlack / samples;
            const frame = { requestedTime, decodedTime: meta.mediaTime, timestampDelta: meta.mediaTime - requestedTime, videoCurrentTime: video.currentTime,
              presentedFrame: { mediaTime: meta.mediaTime, presentedFrames: meta.presentedFrames, width: meta.width, height: meta.height },
              width: canvas.width, height: canvas.height, meanRgb, nonBlackFraction, notBlack: meanRgb > 2 && nonBlackFraction > .05,
              jpegBase64: canvas.toDataURL('image/jpeg', .86).split(',')[1] };
            frames.push(frame);
            hashes.push(crypto.subtle.digest('SHA-256', rgba).then(hash => {
              frame.sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
            }));
          }
        } catch (error) { fail(error); }
      };
      callbackId = video.requestVideoFrameCallback(onFrame);
      video.muted = true; video.playbackRate = 1;
      video.play().catch(fail);
    });
    await Promise.all(hashes);
    const quality = video.getVideoPlaybackQuality();
    const gaps = timeline.slice(1).map((frame, index) => frame.mediaTime - timeline[index].mediaTime);
    const distinctFrames = new Set(frames.map(frame => frame.sha256)).size;
    return { metadata, duration, durationSource: 'metadata', playback: 'sequential 1x; no seek',
      frames, distinctFrames, timeline,
      presentation: { callbacks: timeline.length, maximumMediaTimeGap: Math.max(0, ...gaps), missedPresentationCallbacks: timeline.slice(1).reduce((sum, frame, index) => sum + Math.max(0, frame.presentedFrames - timeline[index].presentedFrames - 1), 0) },
      playbackQuality: { totalVideoFrames: quality.totalVideoFrames, droppedVideoFrames: quality.droppedVideoFrames, corruptedVideoFrames: quality.corruptedVideoFrames },
      ok: frames.length === targets.length && frames.every(frame => frame.notBlack && frame.timestampDelta <= .12) && distinctFrames >= 3,
      limitation: 'Callback timeline describes actual presented frames, not a demuxed enumeration of every encoded packet. JPEG samples cover the four view midpoints and the tail.' };
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(objectUrl); }
}

function options() {
  return Object.fromEntries(process.argv.slice(2).map(argument => {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
    if (!match) throw new Error(`Expected --option=value: ${argument}`);
    return [match[1], match[2] ?? true];
  }));
}

function launch() {
  const args = options();
  if (args.help) { console.log('node scripts/verify-video.cjs --electron=<existing-electron.exe> --video=<existing-world.webm> [--output=<directory>]'); return; }
  for (const key of Object.keys(args)) if (!['electron', 'video', 'output'].includes(key)) throw new Error(`Unknown --${key}`);
  if (typeof args.electron !== 'string' || !fs.existsSync(args.electron)) throw new Error('--electron must name an existing executable');
  if (typeof args.video !== 'string' || !fs.statSync(args.video).isFile()) throw new Error('--video must name an existing file');
  const video = path.resolve(args.video), output = path.resolve(args.output || path.dirname(video));
  fs.mkdirSync(output, { recursive: true });
  const runtime = fs.mkdtempSync(path.join(output, 'video-runtime-'));
  const config = { video, output, runtime, startedAt: new Date().toISOString() };
  const configFile = path.join(runtime, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  const { cleanEnvironment } = require('./baseline.cjs');
  const log = fs.openSync(path.join(output, 'video-verification.log'), 'w');
  const child = require('node:child_process').spawn(path.resolve(args.electron), [__filename, `--config=${configFile}`], { env: cleanEnvironment(runtime), cwd: __dirname, windowsHide: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('spawn', () => console.log(`Video verification PID ${child.pid}; ${path.join(output, 'video-verification.json')}`));
  child.on('exit', (code, signal) => { console.log(`Video verifier exited ${code ?? signal}`); process.exitCode = code ?? 1; });
}

async function runElectron() {
  const { app, BrowserWindow } = require('electron');
  const args = options();
  if (typeof args.config !== 'string') throw new Error('Missing launcher --config');
  const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  const userData = path.join(config.runtime, 'user-data'); fs.mkdirSync(userData, { recursive: true }); app.setPath('userData', userData);
  const report = { ok: false, config, method: 'Offscreen Electron at 60Hz presents the existing Blob WebM sequentially at 1x without seeking. requestVideoFrameCallback records the presentation timeline; sampled RGBA pixels are hashed and exported as JPEG for visual QA.' };
  const save = () => fs.writeFileSync(path.join(config.output, 'video-verification.json'), JSON.stringify(report, null, 2));
  const deadline = setTimeout(() => { report.error = 'Video verification exceeded 60000ms'; save(); app.exit(1); }, 60000);
  let server;
  try {
    await app.whenReady();
    const bytes = fs.readFileSync(config.video);
    report.file = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    const container = inspectWebm(bytes);
    fs.writeFileSync(path.join(config.output, 'video-container-timeline.json'), JSON.stringify(container, null, 2));
    report.container = { frames: container.frames.length, maximumGapSeconds: container.maximumGapSeconds, gapsOver120ms: container.gapsOver120ms, ok: container.ok, file: 'video-container-timeline.json' };
    const sourcePath = path.join(path.dirname(config.video), 'video-source-timeline.json');
    if (fs.existsSync(sourcePath)) {
      const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
      const sameCount = source.frames.length === container.frames.length;
      const errors = sameCount ? source.frames.map((frame, index) => Math.abs(frame.timeMs - container.frames[index].time * 1000)) : [];
      report.sourceAlignment = { sourceFrames: source.frames.length, encodedFrames: container.frames.length, maxTimestampErrorMs: sameCount ? Math.max(...errors) : null,
        ok: sameCount && errors.every(error => error <= 2), method: 'One encoded frame per captured JPEG; PTS compared with original CDP timestamps, allowing at most 2ms container/time-base quantization.' };
    }
    server = require('node:http').createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><title>Local video verification</title><style>video{width:720px;height:450px}canvas{display:none}</style><video muted playsinline preload="auto"></video><canvas></canvas>');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.setFrameRate(60);
    win.webContents.on('render-process-gone', (_event, details) => { report.error = details; save(); app.exit(1); });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    report.decode = await win.webContents.executeJavaScript(`(${decodeVideo.toString()})(${JSON.stringify(bytes.toString('base64'))})`);
    for (const [index, frame] of report.decode.frames.entries()) {
      frame.jpeg = `video-frame-${String(index + 1).padStart(2, '0')}.jpg`;
      fs.writeFileSync(path.join(config.output, frame.jpeg), Buffer.from(frame.jpegBase64, 'base64'));
      delete frame.jpegBase64;
    }
    report.ok = report.decode.ok && report.container.ok && (!report.sourceAlignment || report.sourceAlignment.ok);
    report.file.sha256After = crypto.createHash('sha256').update(fs.readFileSync(config.video)).digest('hex');
    report.file.unchanged = report.file.sha256After === report.file.sha256;
    report.ok &&= report.file.unchanged;
    report.versions = { electron: process.versions.electron, chrome: process.versions.chrome };
    report.completedAt = new Date().toISOString(); save(); console.log(JSON.stringify(report));
    clearTimeout(deadline); win.destroy(); server.close(); app.exit(report.ok ? 0 : 1);
  } catch (error) {
    report.error = error.stack || String(error); save(); console.error(error); clearTimeout(deadline); server?.close(); app.exit(1);
  }
}

if (process.versions.electron) runElectron().catch(error => { console.error(error); require('electron').app.exit(1); });
else { try { launch(); } catch (error) { console.error(error); process.exitCode = 1; } }
