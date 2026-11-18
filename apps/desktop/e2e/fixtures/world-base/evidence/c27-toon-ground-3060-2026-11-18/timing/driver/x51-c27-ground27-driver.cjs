// Ground-only follow-up for PR #254. Run against the recorded C27 fixture.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const [fixture, electron, cameraFile, output] = process.argv.slice(2).map(arg => path.resolve(arg));
if (!output) throw new Error('Expected the fixture, Electron executable, fixed camera JSON and new output directory');
const source = 'e00875bd88109c6b3eb685bbb5aec8d01ef4bf5c';
const head = () => cp.execFileSync('git', ['rev-parse', 'HEAD'], {cwd: fixture, encoding:'utf8', windowsHide: true}).trim();
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
const capturedHead = head();
const mode=process.argv[6]; assert(['on','off'].includes(mode)); const query=mode==='off'?'toon=off':'';
const manifestPath = path.join(__dirname, 'x51-c27-ground27-manifest.json');
const manifest = read(manifestPath);
assert.equal(manifest.head, source);
assert.equal(capturedHead, source);
function verifyScene() {
  assert.equal(head(), capturedHead);
  for (const [file, expected] of Object.entries(manifest.files)) {
    assert.equal(digest(fs.readFileSync(path.join(fixture, file))), expected, file);
  }
}

function selectGroundViews(original) {
  function replaceOnce(text, find, replacement) {
    assert.equal(text.split(find).length, 2, 'Expected one source anchor: ' + find);
    return text.replace(find, () => replacement);
  }
  function omit(text, start, next) {
    assert.equal(text.split(start).length, 2);
    const a = text.indexOf(start), b = text.indexOf(next, a + start.length);
    assert(b > a);
    return text.slice(0, a) + text.slice(b);
  }
  let host = replaceOnce(original, "const { createStaticServer } = require('./baseline.cjs');\nconst config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));",
    "const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));\nconst { createStaticServer } = require(path.join(config.fixture, 'scripts/baseline.cjs'));");
  host = replaceOnce(host, "const CORE_VIEWS = ['station-street', 'station-port', 'island-aerial', 'shop-interior'];", "const CORE_VIEWS = ['station-street', 'shop-interior'];");
  host = omit(host, "      stage('capturing-streetscape');", "      stage('validating-look-controls');");
  host = omit(host, "      stage('capturing-town-details');", "    }\n  } else {");
  return replaceOnce(host, 'report.views.length === 4', 'report.views.length === CORE_VIEWS.length && CORE_VIEWS.every((name, i) => report.views[i].name === name)');
}

function readEffects(w) {
  const mat=w.look.pipeline.finalMat,gl=w.renderer.getContext(),program=w.renderer.properties.get(mat).currentProgram?.program;
  const read=name=>{if(!program)return null;const u=gl.getUniformLocation(program,name);return u?gl.getUniform(program,u):null;};
  return {toon27:!!w.toon27,outline:mat.uniforms.uLnOn.value,outlineGpu:read("uLnOn"),legacyToon:mat.uniforms.uToon.value,
    bands:w.toon27?.params?.lit.levels??null,shadowTint:!!w.shadowTint,decals:w.weatheringDecals.mesh.visible,weathering:w.weathering.uniforms.uWx.value,
    timeOfDay:w.island.timeOfDay,clouds:w.island.sky.cloudOn.value,water:w.island.water.mesh.visible,wetRoad:w.station.wetRoad.enabled};
}
async function readChunks() {
  const {ShaderChunk}=await import("three");return {litBands:ShaderChunk.lights_fragment_end.includes("wbToonBands"),coverage:ShaderChunk.opaque_fragment.includes("wbToonMask"),shadowTint:ShaderChunk.lights_fragment_end.includes("wbShadowTint")};
}
function effectExpected(on){
  return {toon27:on,outline:Number(on),outlineGpu:Number(on),legacyToon:1,bands:on?[0,.55,1]:null,shadowTint:true,decals:true,weathering:1,timeOfDay:'evening',clouds:1,water:true,wetRoad:true};
}
const expectedEffects=effectExpected(mode==="on"),expectedChunks={litBands:mode==="on",coverage:mode==="on",shadowTint:true};
const roomIds=["E1","E2","E3","E5","W1","W2","W4","W6"];
function checkRooms(s){assert.deepEqual(s.roomIds,roomIds);assert.deepEqual(s.boundIds,roomIds);}
verifyScene();
fs.mkdirSync(output);
const normal = path.join(output, 'street-and-walk');
const town = path.join(output, 'town');
fs.mkdirSync(normal);
const runtime = fs.mkdtempSync(path.join(normal, 'runtime-'));
const scripts = path.join(fixture, 'scripts');
const canonical = fs.readFileSync(path.join(scripts, 'preview-host.cjs'), 'utf8').replace(/\r\n/g, '\n');
let host=selectGroundViews(canonical);
const audit="weatheringInitialization: {totalMs:f.weatheringMs,source:f.weatheringDecals.stats.source,planMs:f.weatheringDecals.stats.planMs,rays:f.weatheringDecals.stats.rays,triangles:f.weatheringDecals.stats.triangles,vehicleVolumes:f.weathering.stats.vehicleVolumes}, effects:window.__groundEffects(f),roomIds:f.station.ctx.services.shopInteriors.map(r=>r.lot).sort(),boundIds:(f.shadowTint?.indoorBox||[]).map(r=>r.id).sort(),indoorBoxCount: f.shadowTint?.indoorBox?.length ?? 0, weatheringState: { strength: f.weathering.uniforms.uWx.value, decals: f.weatheringDecals.mesh.visible, shadowTint: Boolean(f.shadowTint) },";
assert.equal(host.split("ready: window.__worldCapture.sceneReadyMs !== null,").length,2);
host=host.replace("ready: window.__worldCapture.sceneReadyMs !== null,",audit+" ready: window.__worldCapture.sceneReadyMs !== null,");
const installProbe='function instrumentPage() { window.__groundEffects = '+readEffects.toString()+';';
const instrument='function instrumentPage() {'; assert.equal(host.split(instrument).length,2);host=host.replace(instrument,()=>installProbe);
const walk='feet: window.worldBase.walker.worldPosition.toArray(), mode: window.worldBase.walker.view, timeMs: performance.now()';assert.equal(host.split(walk).length,3);
host=host.replaceAll(walk,'effects: window.__groundEffects(window.worldBase), '+walk);
const final='report.finalScene = await evaluate';assert.equal(host.split(final).length,2);
host=host.replace(final,()=> 'report.shaderChunks = await evaluate('+JSON.stringify('('+readChunks.toString()+')()')+');\n  '+final);
const hostPath = path.join(runtime, 'ground-preview.cjs');
fs.writeFileSync(hostPath, host);
const startedAt = new Date().toISOString();
const sourceFile = path.join(normal, 'source-manifest.json');
write(sourceFile, {...manifest, head: capturedHead, capturedAt: startedAt, verifiedSceneRevision: source});
const config = {
  scene: 'combined', fixture, output: normal, runtime, source: fixture,
  preview: false, videoOnly: false, ffmpeg: null, width: 1440, height: 900, sampleMs: 15000,
  warmupMs: 5000, timeoutMs: 420000, videoMs: 0, query, proxy: '', startedAt,
  entrySha256: manifest.files['index.html'],
  sourceManifest: {file: 'source-manifest.json', head: capturedHead, sha256: digest(fs.readFileSync(sourceFile))}
};
write(path.join(normal, 'run-config.json'), config);
const transport = require(path.join(scripts, 'baseline.cjs'));
const log = fs.openSync(path.join(normal, 'electron.log'), 'wx');
const result = cp.spawnSync(electron, [hostPath, path.join(normal, 'run-config.json')], {
  cwd: fixture, windowsHide: true, stdio: ['ignore', log, log], env: transport.cleanEnvironment(runtime)
});
fs.closeSync(log);
if (result.error) throw result.error;
const report = read(path.join(normal, 'render-report.json'));
const provenance = {startedAt, source, checkout: capturedHead, verifiedFiles: Object.keys(manifest.files).length,
  upstreamManifestSha256: digest(fs.readFileSync(manifestPath)), canonicalPreviewSha256: digest(fs.readFileSync(path.join(scripts, 'preview-host.cjs'))),
  groundPreviewSha256: digest(host), cameraFileSha256: digest(fs.readFileSync(cameraFile)),
  normal: {exit: result.status, signal: result.signal, complete: report.stage === 'complete', renderOk: report.renderOk, transportClean: report.transportClean}};
write(path.join(output, 'runs.json'), provenance);
if (!provenance.normal.complete || !report.renderOk) throw new Error('Incomplete normal session: ' + JSON.stringify(report.failure || report.stage));
assert.deepEqual(report.views.map(v => v.name), ['station-street', 'shop-interior']);
assert.deepEqual(report.walkingValidation.segments.map(s => s.mode), ['third', 'first']);
assert(report.walkingValidation.ok); for(const v of report.views) assert.deepEqual(v.scene.weatheringState,{strength:1,decals:true,shadowTint:true});
for(const v of report.views) assert.equal(v.scene.indoorBoxCount,8);
for(const v of report.views) checkRooms(v.scene);
for(const v of report.views)assert.deepEqual(v.scene.effects,expectedEffects);
for(const v of report.walkingValidation.segments)for(const s of [v.before,v.after])assert.deepEqual(s.effects,expectedEffects);
assert.deepEqual(report.shaderChunks,expectedChunks);
assert(!report.stageHistory.some(item => /capturing-streetscape|capturing-town-details|island-aerial|station-port/.test(item.stage)));
verifyScene();
const upstreamTown=path.join(fixture,'evidence/street-upgrade-2026-11-18/town/town-frame-times.cjs'); const townDriver=path.join(output,'town-frame-times.cjs');
let townSource=fs.readFileSync(upstreamTown,'utf8').replace(/\r\n/g,'\n');
const anchor="server.address().port+'/'";assert.equal(townSource.split(anchor).length,2);townSource=townSource.replace(anchor,"server.address().port+"+JSON.stringify('/'+(query?'?'+query:'')));
const state='return {camera:{position:w.camera.position.toArray()';assert.equal(townSource.split(state).length,2);townSource=townSource.replace(state,'return {effects:window.__groundEffects(w),roomIds:w.station.ctx.services.shopInteriors.map(r=>r.lot).sort(),boundIds:(w.shadowTint?.indoorBox||[]).map(r=>r.id).sort(),indoorBoxCount:w.shadowTint?.indoorBox?.length??0,weatheringState:{strength:w.weathering.uniforms.uWx.value,decals:w.weatheringDecals.mesh.visible,shadowTint:Boolean(w.shadowTint)},camera:{position:w.camera.position.toArray()');
const baseViews="['24','laundry-details']", baseLen='report.segments.length===4';assert.equal(townSource.split(baseViews).length,2);assert.equal(townSource.split(baseLen).length,2);
townSource=townSource.replace(baseViews,baseViews+",['window','street-detail'],['door','shop-door-eye']").replace(baseLen,'report.segments.length===6');
const pageSelect='const w = window.worldBase, p = w.look.pipeline';assert.equal(townSource.split(pageSelect).length,2);
townSource=townSource.replace(pageSelect,()=> 'window.__groundEffects = '+readEffects.toString()+';\n  '+pageSelect);
const finish="report.stage='complete';";assert.equal(townSource.split(finish).length,2);
townSource=townSource.replace(finish,()=> 'report.shaderChunks = await evaluate('+JSON.stringify('('+readChunks.toString()+')()')+');\n    '+finish);
fs.writeFileSync(townDriver,townSource);
const townResult = cp.spawnSync(process.execPath, [townDriver, fixture, electron, cameraFile, sourceFile, town], {
  cwd: fixture, windowsHide: true, encoding: 'utf8'
});
if (townResult.error) throw townResult.error;
const timing = read(path.join(town, 'timing-report.json'));
provenance.town = {exit: townResult.status, signal: townResult.signal, complete: timing.stage === 'complete', renderOk: timing.renderOk, transportClean: timing.transportClean, driverSha256: digest(fs.readFileSync(townDriver))};
provenance.finishedAt = new Date().toISOString();
write(path.join(output, 'runs.json'), provenance);
if (!provenance.town.complete || !timing.renderOk) throw new Error('Incomplete town session: ' + JSON.stringify(timing.failure || timing.stage));
assert.deepEqual(timing.segments.map(s => s.id), ['20', '21', '23', '24', 'window', 'door']);
assert(timing.segments.every(s => s.valid)); for(const v of timing.segments) for(const s of [v.before,v.after])assert.deepEqual(s.weatheringState,{strength:1,decals:true,shadowTint:true});
verifyScene();
for(const v of timing.segments) for(const s of [v.before,v.after]) assert.equal(s.indoorBoxCount,8);
for(const v of timing.segments) for(const s of [v.before,v.after]) checkRooms(s);
for(const v of timing.segments)for(const s of [v.before,v.after])assert.deepEqual(s.effects,expectedEffects);
assert.deepEqual(timing.shaderChunks,expectedChunks);
console.log(JSON.stringify(provenance));
