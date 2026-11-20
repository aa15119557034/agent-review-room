// x51-shadowcount.cjs —— 直接数 90 帧里每帧的绘制调用，看阴影 pass 还出现几次
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const LABEL = (process.argv.indexOf('--label') > -1) ? process.argv[process.argv.indexOf('--label') + 1] : 'x'
const TARGET = process.env.X51_TARGET || 'http://127.0.0.1:4181/?time=evening'

const FN = `
window.__shadowCount = async (frames) => {
  const wb = window.worldBase
  const r = wb.renderer
  wb.setView('art-a-street')
  r.setPixelRatio(1); r.setSize(1440, 900, false)
  await new Promise(res => { let i = 0; const t = () => { if (++i < 10) requestAnimationFrame(t); else res() }; requestAnimationFrame(t) })
  const calls = []
  await new Promise(res => {
    let n = 0
    const tick = () => { calls.push(r.info.render.calls); if (++n < frames) requestAnimationFrame(tick); else res() }
    requestAnimationFrame(tick)
  })
  const uniq = {}
  for (const c of calls) uniq[c] = (uniq[c] || 0) + 1
  const vals = Object.keys(uniq).map(Number).sort((a, b) => a - b)
  return {
    frames: calls.length,
    minCalls: vals[0],
    maxCalls: vals[vals.length - 1],
    // 高于最小值 100 次的帧数 = 出现阴影 pass 的帧数
    shadowFrames: calls.filter(c => c > vals[0] + 100).length,
    histogram: uniq
  }
}
`

app.whenReady().then(async () => {
  const bw = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(__dirname, 'preload-freeze.js'), contextIsolation: false } })
  await bw.loadURL(TARGET)
  await bw.webContents.executeJavaScript(FN + '; true')
  for (let i = 0; i < 900; i++) {
    if (await bw.webContents.executeJavaScript('!!(window.worldBase && window.worldBase.ready)')) break
    await new Promise(r => setTimeout(r, 200))
  }
  const res = await bw.webContents.executeJavaScript('window.__shadowCount(90)')
  const rec = { label: LABEL, target: TARGET, at: new Date().toISOString(), result: res }
  fs.mkdirSync(path.join(__dirname, 'records'), { recursive: true })
  fs.writeFileSync(path.join(__dirname, 'records', `shadowcount-${LABEL}.json`), JSON.stringify(rec, null, 2))
  console.log('___SHADOWCOUNT___' + JSON.stringify(rec))
  setTimeout(() => app.quit(), 100)
})
