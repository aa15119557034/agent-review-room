// x51-capture.cjs —— 真场景逐机位截图 + 指标采集（离屏，不占屏）
//
// 用法（地址走环境变量 X51_TARGET，命令行带 URL 会让 Electron 起不来）：
//   $env:X51_TARGET='http://127.0.0.1:4173/?time=evening'
//   electron x51-capture.cjs --label cand --views "a,b,c"
//
// 产出：<out>/<label>-<view>.png  以及一个汇总 JSON（绘制调用/三角面/近白像素/定点投影）

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-gpu-vsync')
app.commandLine.appendSwitch('disable-frame-rate-limit')

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const TARGET = process.env.X51_TARGET || 'http://127.0.0.1:4173/?time=evening'
const LABEL = arg('label', 'shot')
const W = +arg('width', 1440)
const H = +arg('height', 900)
const OUT = arg('out', path.join(__dirname, 'records', 'shots'))
const VIEWS = arg('views', 'art-a-street,art-b-konbini,art-c-alley,art-d-laundry,sample-e-harbour,sample-f-hillside,sample-g-rail,sample-h-north').split(',')
// W1 浮空点（C酱 给的）
const WORLD_POINT = [274.27, 8.47, 914.08]

const PAGE_FN = `
window.__x51capture = async (view, W, H, worldPoint) => {
  const wb = window.worldBase
  if (!wb || !wb.ready) return { view, error: 'not ready' }
  wb.setView(view)
  const r = wb.renderer
  r.setPixelRatio(1)
  r.setSize(W, H, false)
  // 预热 60 帧，排掉着色器编译/纹理上传
  await new Promise(res => { let n = 0; const t = () => { if (++n < 60) requestAnimationFrame(t); else res() }; requestAnimationFrame(t) })
  await new Promise(res => setTimeout(res, 250))

  const gl = r.getContext()
  // 定点投影：把世界坐标投到屏幕像素
  let proj = null
  try {
    const cam = wb.camera
    const v = cam.position.clone()
    v.set(worldPoint[0], worldPoint[1], worldPoint[2])
    v.project(cam)
    proj = {
      world: worldPoint,
      ndc: [ +v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4) ],
      px: [ Math.round((v.x * 0.5 + 0.5) * gl.drawingBufferWidth), Math.round((-v.y * 0.5 + 0.5) * gl.drawingBufferHeight) ],
      inFront: v.z < 1
    }
  } catch (e) { proj = { error: String(e) } }

  // preserveDrawingBuffer 已由 preload 打开，直接取即可
  const dataUrl = r.domElement.toDataURL('image/png')
  const st = wb.frameStats || {}
  return {
    view,
    buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    calls: st.calls ?? null,
    triangles: st.triangles ?? null,
    fps: st.fps ? +st.fps.toFixed(2) : null,
    proj,
    png: dataUrl
  }
}

// 绘制调用排行：按材质聚合，统计网格数与三角面数
window.__x51calls = () => {
  const wb = window.worldBase
  const scene = wb.scene
  const rows = new Map()
  const tmp = new Map()
  scene.traverse(o => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh) return
    if (!o.visible) return
    const geo = o.geometry
    const mat = Array.isArray(o.material) ? o.material[0] : o.material
    const key = (mat && (mat.name || mat.type)) + ' | ' + (geo && geo.type)
    const tri = geo && geo.index ? geo.index.count / 3 : (geo && geo.attributes.position ? geo.attributes.position.count / 3 : 0)
    const inst = o.isInstancedMesh ? o.count : 1
    const cur = rows.get(key) || { key, meshes: 0, instances: 0, tris: 0 }
    cur.meshes += 1
    cur.instances += inst
    cur.tris += tri * inst
    rows.set(key, cur)
  })
  const list = [...rows.values()].sort((a, b) => b.meshes - a.meshes)
  return {
    totalMeshes: list.reduce((s, x) => s + x.meshes, 0),
    groups: list.length,
    top: list.slice(0, 25).map(x => ({ ...x, tris: Math.round(x.tris) }))
  }
}
`

app.whenReady().then(async () => {
  const bw = new BrowserWindow({ width: W, height: H, useContentSize: true, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(__dirname, 'preload-capture.js'), contextIsolation: false } })
  await bw.loadURL(TARGET)
  await bw.webContents.executeJavaScript(PAGE_FN + '; true')

  let ready = false
  for (let i = 0; i < 600; i++) {
    ready = await bw.webContents.executeJavaScript('!!(window.worldBase && window.worldBase.ready)')
    if (ready) break
    await new Promise(r => setTimeout(r, 200))
  }
  if (!ready) { console.log('___X51_CAP___' + JSON.stringify({ ok: false, reason: 'not ready' })); app.exit(1); return }

  fs.mkdirSync(OUT, { recursive: true })
  const summary = { label: LABEL, target: TARGET, at: new Date().toISOString(), expected: [W, H], views: [] }

  for (const v of VIEWS) {
    const r = await bw.webContents.executeJavaScript(`window.__x51capture(${JSON.stringify(v)}, ${W}, ${H}, ${JSON.stringify(WORLD_POINT)})`)
    if (r && r.png) {
      const buf = Buffer.from(r.png.split(',')[1], 'base64')
      const file = path.join(OUT, `${LABEL}-${v}.png`)
      fs.writeFileSync(file, buf)
      const pngW = buf.readUInt32BE(16), pngH = buf.readUInt32BE(20)
      summary.views.push({ view: r.view, buffer: r.buffer, pngPixels: [pngW, pngH], calls: r.calls, triangles: r.triangles, fps: r.fps, proj: r.proj, file: path.basename(file) })
      console.log(`  ${v}: ${pngW}x${pngH} calls=${r.calls} tris=${r.triangles} ${r.proj && r.proj.px ? 'W1@' + r.proj.px.join(',') : ''}`)
    } else {
      summary.views.push({ view: v, error: r && r.error })
      console.log(`  ${v}: 失败 ${r && r.error}`)
    }
  }

  const calls = await bw.webContents.executeJavaScript('window.__x51calls()')
  summary.callsTop = calls
  fs.writeFileSync(path.join(OUT, `${LABEL}-summary.json`), JSON.stringify(summary, null, 2))
  console.log('___X51_CAP___' + JSON.stringify({ ok: true, out: OUT, views: summary.views.length }))
  setTimeout(() => app.quit(), 150)
})




