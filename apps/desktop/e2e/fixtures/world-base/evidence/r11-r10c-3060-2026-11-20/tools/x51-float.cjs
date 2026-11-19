// x51-float.cjs —— 用几何测量判定"光斑是否离地"，不靠肉眼
//
// 做法：在场景里找到世界坐标附近的 InstancedMesh 实例，读它的 Y；
//       再从该点上方垂直向下打射线，排除那片光斑本身，取最近的地面命中点；
//       两者之差 = 离地高度。
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.commandLine.appendSwitch('force-device-scale-factor', '1')

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const TARGET = process.env.X51_TARGET || 'http://127.0.0.1:4173/?time=evening'
const LABEL = arg('label', 'float')
const POINTS = (arg('points', '')).trim()
  ? arg('points').split(';').map(s => s.split(',').map(Number))
  : [[274.27, 8.47, 914.08]]

const PAGE = `
window.__x51float = async (points) => {
  const THREE = await import('./upstream/petalwake/vendor/three/build/three.module.js')
  const wb = window.worldBase
  const scene = wb.scene
  const out = []

  // 收集所有 InstancedMesh 实例的世界 Y 与 XZ
  const inst = []
  scene.traverse(o => {
    if (!o.isInstancedMesh) return
    const m = new THREE.Matrix4()
    const v = new THREE.Vector3()
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m)
      v.setFromMatrixPosition(m)
      v.applyMatrix4(o.matrixWorld)
      inst.push({ mesh: o, i, x: v.x, y: v.y, z: v.z })
    }
  })

  for (const p of points) {
    const [px, py, pz] = p
    // 找水平距离 < 1.0 m 且 Y 在 p.y 附近 3 m 内的实例
    const near = inst
      .map(o => ({ ...o, dxz: Math.hypot(o.x - px, o.z - pz), dy: o.y - py }))
      .filter(o => o.dxz < 1.0 && Math.abs(o.dy) < 3.0)
      .sort((a, b) => a.dxz - b.dxz)

    if (!near.length) { out.push({ point: p, found: false }); continue }

    const best = near[0]
    const ray = new THREE.Raycaster(
      new THREE.Vector3(px, py + 5, pz),
      new THREE.Vector3(0, -1, 0)
    )
    const hits = ray.intersectObject(scene, true)
      .filter(h => h.object !== best.mesh)   // 排除那片光斑自己
      .slice(0, 10)

    const ground = hits.map(h => ({
      y: +h.point.y.toFixed(4),
      object: h.object.type,
      material: (h.object.material && (h.object.material.name || h.object.material.type)) || '?'
    }))

    out.push({
      point: p,
      found: true,
      patchY: +best.y.toFixed(4),
      patchDxz: +best.dxz.toFixed(3),
      patchMesh: best.mesh.name || best.mesh.type,
      patchMaterial: (best.mesh.material && (best.mesh.material.name || best.mesh.material.type)) || '?',
      instanceCount: best.mesh.count,
      groundY: ground[0] ? ground[0].y : null,
      groundObject: ground[0] ? ground[0].object : null,
      groundMaterial: ground[0] ? ground[0].material : null,
      gap: ground[0] ? +(best.y - ground[0].y).toFixed(4) : null,
      nearestHits: ground
    })
  }
  return out
}
`

app.whenReady().then(async () => {
  const bw = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(__dirname, 'preload-capture.js'), contextIsolation: false } })
  await bw.loadURL(TARGET)
  await bw.webContents.executeJavaScript(PAGE + '; true')

  let ready = false
  for (let i = 0; i < 600; i++) {
    ready = await bw.webContents.executeJavaScript('!!(window.worldBase && window.worldBase.ready)')
    if (ready) break
    await new Promise(r => setTimeout(r, 200))
  }
  if (!ready) { console.log('___X51_FLOAT___' + JSON.stringify({ ok: false, reason: 'not ready' })); app.exit(1); return }

  const res = await bw.webContents.executeJavaScript(`window.__x51float(${JSON.stringify(POINTS)})`)
  const rec = { label: LABEL, target: TARGET, at: new Date().toISOString(), results: res }
  const outDir = path.join(__dirname, 'records')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, `float-${LABEL}.json`), JSON.stringify(rec, null, 2))
  console.log('___X51_FLOAT___' + JSON.stringify(rec))
  setTimeout(() => app.quit(), 100)
})
