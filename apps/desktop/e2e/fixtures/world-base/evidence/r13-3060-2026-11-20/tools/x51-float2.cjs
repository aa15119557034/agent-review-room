// x51-float2.cjs —— 合并网格版的浮空检查
// 对 shop-spill 合并网格抽样顶点，逐点比较"顶点 Y"与"该点正下方地面 Y"，统计离地分布。
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const LABEL = (process.argv.indexOf('--label') > -1) ? process.argv[process.argv.indexOf('--label') + 1] : 'x'
const TARGET = process.env.X51_TARGET || 'http://127.0.0.1:4175/?time=evening&grade=off'
const SAMPLES = +(process.env.X51_SAMPLES || 300)

const FN = `
window.__x51float2 = async (samples) => {
  const THREE = await import('./upstream/petalwake/vendor/three/build/three.module.js')
  const wb = window.worldBase
  const scene = wb.scene

  // 找 shop-spill 网格
  let mesh = null
  scene.traverse(o => {
    if (mesh) return
    const m = Array.isArray(o.material) ? o.material[0] : o.material
    if (m && (m.name === 'shop-spill' || (o.userData && o.userData.wbShopSpill))) mesh = o
  })
  if (!mesh) return { found: false, reason: 'shop-spill mesh not found' }

  const pos = mesh.geometry.getAttribute('position')
  const idxArr = mesh.geometry.getIndex() ? mesh.geometry.getIndex().array : null
  const idxSet = new Set(idxArr ? Array.from(idxArr) : [])
  const n = pos.count
  const step = Math.max(1, Math.floor(n / samples))
  const ray = new THREE.Raycaster()
  const down = new THREE.Vector3(0, -1, 0)
  const origin = new THREE.Vector3()
  const gaps = []
  const bad = []

  for (let i = 0; i < n; i += step) {
    const vw = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld)
    const x = vw.x, y = vw.y, z = vw.z
    origin.set(x, y + 5, z)
    ray.set(origin, down)
    // 只认顶点下方的地面：高于顶点的命中是雨棚/雨檐，不算地面
    const hits = ray.intersectObject(scene, true).filter(h => h.object !== mesh && h.point.y < y - 0.001)
    if (!hits.length) continue
    const gap = y - hits[0].point.y
    gaps.push(gap)
    if (Math.abs(gap - 0.02) > 0.02) bad.push({ i, x: +x.toFixed(2), y: +y.toFixed(3), z: +z.toFixed(2), gap: +gap.toFixed(4) })
  }
  gaps.sort((a, b) => a - b)
  const q = p => gaps.length ? +gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))].toFixed(4) : null
  return {
    found: true,
    meshVertices: n,
    drawCallsForMesh: 1,
    sampled: gaps.length,
    gapP50: q(0.5), gapP95: q(0.95), gapMax: q(1), gapMin: q(0),
    outliers: bad.map(b => ({ ...b, referenced: idxSet.has(b.i) })).slice(0, 12),
    outlierCount: bad.length
  }
}
`

app.whenReady().then(async () => {
  const bw = new BrowserWindow({ width: 640, height: 480, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(__dirname, 'preload-freeze.js'), contextIsolation: false } })
  await bw.loadURL(TARGET)
  await bw.webContents.executeJavaScript(FN + '; true')
  for (let i = 0; i < 600; i++) {
    if (await bw.webContents.executeJavaScript('!!(window.worldBase && window.worldBase.ready)')) break
    await new Promise(r => setTimeout(r, 200))
  }
  const res = await bw.webContents.executeJavaScript(`window.__x51float2(${SAMPLES})`)
  const rec = { label: LABEL, target: TARGET, at: new Date().toISOString(), result: res }
  fs.mkdirSync(path.join(__dirname, 'records'), { recursive: true })
  fs.writeFileSync(path.join(__dirname, 'records', `float2-${LABEL}.json`), JSON.stringify(rec, null, 2))
  console.log('___X51_FLOAT2___' + JSON.stringify(rec))
  setTimeout(() => app.quit(), 100)
})



