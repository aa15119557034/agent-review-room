// x51-real-probe.cjs —— 对真实场景跑 GPU 帧时
//
// 用法：
//   electron x51-real-probe.cjs --url http://127.0.0.1:4173/ --secs 2
//   electron x51-real-probe.cjs --url http://127.0.0.1:4173/ --views art-a-street,art-b-konbini
//
// 做法：
//   1. 离屏窗口加载真实页面（不显示、不占屏）
//   2. 逐机位调用页面自己的 worldBase.setView(name)
//   3. 把 renderer 尺寸钉成 1440x900 / pixelRatio 1（不依赖窗口和系统缩放）
//   4. 两个口径同时量：rAF 间隔（总帧时，需 --disable-frame-rate-limit）与 renderer.render 的 GPU 时间

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// 落盘日志：Electron 的 stdout 在 Windows 下有时抓不到，出问题只能靠这个
const LOGF = path.join(__dirname, 'records', '_real-probe.log')
const log = (...a) => { try { fs.appendFileSync(LOGF, a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n') } catch {} }
try { fs.mkdirSync(path.dirname(LOGF), { recursive: true }) } catch {}
log('--- boot', new Date().toISOString())
process.on('uncaughtException', (e) => { log('uncaught', e && e.stack || String(e)) })
process.on('unhandledRejection', (e) => { log('unhandled', e && e.stack || String(e)) })

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-gpu-vsync')
app.commandLine.appendSwitch('disable-frame-rate-limit')

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const URL_TARGET = process.env.X51_TARGET || arg('target', 'http://127.0.0.1:4173/')   // 用环境变量传：命令行里带 URL 会让 Electron 起不来
const SECS = +arg('secs', 2)
const W = +arg('width', 1440)
const H = +arg('height', 900)
const LABEL = arg('label', 'real')
const OUT_DIR = arg('out', path.join(__dirname, 'records'))
const VIEWS = arg('views', 'art-a-street,art-b-konbini,art-c-alley,art-d-laundry,sample-e-harbour,sample-f-hillside,sample-g-rail,sample-h-north').split(',')

const MEASURE = `
window.__x51measure = async (view, secs, W, H) => {
  const wb = window.worldBase
  if (!wb || !wb.ready) return { view, error: 'worldBase not ready' }
  if (wb.setView) wb.setView(view)
  const r = wb.renderer
  r.setPixelRatio(1)
  r.setSize(W, H, false)
  // 预热：先空跑 60 帧，把着色器编译/纹理上传这些冷启动开销排掉
  await new Promise(res => { let n = 0; const t = () => { if (++n < 60) requestAnimationFrame(t); else res() }; requestAnimationFrame(t) })
  await new Promise(res => setTimeout(res, 300))

  const gl = r.getContext()
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
  const qs = []
  let frameNo = 0
  let curFrame = 0
  const orig = r.render.bind(r)
  if (ext) {
    r.render = function (...a) {
      const q = gl.createQuery()
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q)
      orig(...a)
      gl.endQuery(ext.TIME_ELAPSED_EXT)
      qs.push({ q, frame: curFrame })
    }
  }

  const intervals = []
  let last = performance.now(), n = 0
  const t0 = performance.now()
  await new Promise(res => {
    const tick = (t) => {
      curFrame = ++frameNo
      if (n > 2) intervals.push(t - last)
      last = t
      n++
      if (t - t0 < secs * 1000) requestAnimationFrame(tick); else res()
    }
    requestAnimationFrame(tick)
  })

  r.render = orig

  const gpu = []
  const perFrame = new Map()
  if (ext) {
    qs.forEach(({ q, frame }) => {
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6
        gpu.push(ms)
        perFrame.set(frame, (perFrame.get(frame) || 0) + ms)
      }
    })
  }
  const frameTotals = [...perFrame.values()]

  const gpuSum = gpu.reduce((s, x) => s + x, 0)
  const frames = Math.max(1, intervals.length)
  const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(3) }
  const st = wb.frameStats || {}
  return {
    view,
    buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    renderCalls: st.calls ?? null,
    triangles: st.triangles ?? null,
    rAFcount: intervals.length,
    frameP50: q(intervals, 0.5), frameP95: q(intervals, 0.95), frameMax: q(intervals, 1),
    gpuCount: gpu.length,
    gpuSumMs: +gpuSum.toFixed(3),
    frameTotalCount: frameTotals.length,
    gpuFrameP50: q(frameTotals, 0.5),
    gpuFrameP95: q(frameTotals, 0.95),
    gpuFrameMax: q(frameTotals, 1),
    gpuAvgPerFrame: +(gpuSum / frames).toFixed(3),
    gpuP50: q(gpu, 0.5), gpuP95: q(gpu, 0.95), gpuMax: q(gpu, 1),
    timerQuery: !!ext
  }
}
`

app.whenReady().then(async () => {
  log('whenReady')
  const watchdog = setTimeout(() => { log('watchdog: 超时强制退出'); app.exit(2) }, 180000); watchdog.unref && watchdog.unref()
  const bw = new BrowserWindow({
    width: W, height: H, useContentSize: true, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })

  const errors = []
  bw.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message)
  })

  log('loadURL', URL_TARGET)
  await bw.loadURL(URL_TARGET)
  log('loaded')
  await bw.webContents.executeJavaScript(MEASURE + '; true')
  log('measure-fn-installed')

  // 等场景加载完（worldBase.ready）
  let ready = false
  for (let i = 0; i < 600; i++) {
    ready = await bw.webContents.executeJavaScript('!!(window.worldBase && window.worldBase.ready)')
    if (ready) break
    if (i % 10 === 0) log('waiting-ready', i)
    await new Promise(r => setTimeout(r, 200))
  }
  if (!ready) {
    const errs = await bw.webContents.executeJavaScript('(window.worldBase && window.worldBase.errors) || []').catch(() => [])
    console.log('___X51_REAL___' + JSON.stringify({ ok: false, reason: 'scene not ready', errors: [...errors, ...(errs || [])].slice(0, 8) }))
    setTimeout(() => app.quit(), 100)
    return
  }

  log('ready, views=', VIEWS.join(','))
  log('ready, views=', VIEWS.join(','))
  const results = []
  for (const v of VIEWS) {
    const r = await bw.webContents.executeJavaScript(`window.__x51measure(${JSON.stringify(v)}, ${SECS}, ${W}, ${H})`)
    results.push(r)
    console.log('  ' + v + '  frameP50=' + r.frameP50 + 'ms  gpuP50=' + r.gpuP50 + 'ms  calls=' + r.renderCalls)
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const record = {
    label: LABEL, at: new Date().toISOString(), url: URL_TARGET,
    expect: { width: W, height: H },
    flags: { vsyncOff: !app.commandLine.hasSwitch('disable-gpu-vsync') ? false : true, frameLimitOff: app.commandLine.hasSwitch('disable-frame-rate-limit'), scale: app.commandLine.getSwitchValue('force-device-scale-factor') },
    results
  }
  const jsonPath = path.join(OUT_DIR, `real-${LABEL}-${stamp}.json`)
  fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2))
  console.log('___X51_REAL___' + JSON.stringify({ ok: true, json: jsonPath, results }))
  setTimeout(() => app.quit(), 150)
})








