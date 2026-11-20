'use strict';
// Uses the pinned Three.js r187 CubeCamera orientation/API (MIT, upstream/petalwake/vendor/three).
// Scene source and third-party asset ownership stay with the fixture manifests.
// Offline six-face street reflection bake. Runtime consumes PNG sRGB decode * 2.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const fixture = path.resolve(__dirname, '..');
const { createStaticServer, cleanEnvironment } = require('./baseline.cjs');
const { installGate } = require('./diagnose-surface.cjs');
const { sceneFiles } = require('./diagnose-wet-road.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const head = () => cp.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fixture,
    encoding: 'utf8',
    windowsHide: true
}).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function launch() {
    const args = Object.fromEntries(process.argv.slice(2).map(arg => {
        const m = /^--(electron|output)=(.+)$/.exec(arg);
        if (!m)
            throw Error('Usage: node scripts/bake-street-reflections.cjs --electron=<existing executable> --output=<new directory>');
        return [m[1], m[2]];
    }));
    if (!args.electron || !args.output)
        throw Error('Both --electron and --output are required');
    const output = path.resolve(args.output);
    if (fs.existsSync(output))
        throw Error('Output exists; preserve the earlier bake');
    fs.mkdirSync(output, { recursive: true });
    const assets = require('./prepare-props.cjs').verifyPreparedAssets(fixture);
    if (assets.files.length !== 9)
        throw Error('Expected all nine pinned prop assets');
    const config = {
        fixture,
        output,
        head: head(),
        startedAt: new Date().toISOString(),
        runtime: fs.mkdtempSync(path.join(output, 'runtime-')),
        timeoutMs: 180000,
        driverSha256: hash(fs.readFileSync(__filename)),
        electron: path.resolve(args.electron)
    };
    fs.writeFileSync(path.join(output, 'source-manifest.json'), JSON.stringify({
        head: config.head,
        files: sceneFiles(),
        driverSha256: config.driverSha256
    }, null, 2));
    fs.writeFileSync(path.join(output, 'prop-assets-manifest.json'), JSON.stringify(assets, null, 2));
    fs.writeFileSync(path.join(output, 'run-config.json'), JSON.stringify(config, null, 2));
    const configFile = path.join(config.runtime, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    const log = fs.openSync(path.join(output, 'electron.log'), 'w');
    const child = cp.spawn(config.electron, [__filename, configFile], {
        cwd: fixture,
        windowsHide: true,
        env: cleanEnvironment(config.runtime),
        stdio: ['ignore', log, log]
    });
    fs.closeSync(log);
    child.on('spawn', () => {
        fs.writeFileSync(path.join(output, 'process.json'), JSON.stringify({ pid: child.pid, executable: config.electron }));
        console.log('Bake PID ' + child.pid + '; ' + output);
    });
    child.on('error', e => {
        console.error(e);
        process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
        fs.writeFileSync(path.join(output, 'process-exit.json'), JSON.stringify({
            code,
            signal,
            completedAt: new Date().toISOString()
        }));
        console.log('Electron exited ' + code);
        process.exitCode = code === 0 ? 0 : 1;
    });
}
async function prepareBake() {
    const T = await import('three'), w = worldBase, s = w.station, r = w.renderer, gl = r.getContext(), gate = window.__surfaceGate;
    const saved = {
        camera: w.camera.clone(),
        walking: w.walker.enabled,
        time: w.island.U.uTime.value,
        stationTime: s.ctx.time,
        sky: w.island.sky.material.uniforms.uEnv.value,
        target: r.getRenderTarget(),
        face: r.getActiveCubeFace(),
        mip: r.getActiveMipmapLevel(),
        xr: r.xr.enabled,
        auto: r.shadowMap.autoUpdate,
        needs: r.shadowMap.needsUpdate
    };
    const ref = s.streetReflections;
    if (!ref)
        throw Error('Missing station street reflection definition');
    const origin = ref.uniforms.uStreetOrigin.value.clone();
    const localOrigin = [origin.x, origin.y, origin.z];
    const glass = new Map();
    w.scene.traverse(o => {
        for (const m of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [])
            if (m.name === 'station-street-window')
                glass.set(m, m.visible);
    });
    if (!glass.size)
        throw Error('Expected actual street window materials');
    // The wet-road owner exports an explicit enabled getter in this fixture.
    const originalWet = s.wetRoad.enabled;
    if (typeof originalWet !== 'boolean')
        throw Error('Wet-road enabled state is unavailable');
    if (!w.island.root.children.includes(w.island.sky.mesh))
        throw Error('Expected procedural sky as a direct island child');
    const excluded = new Map();
    for (const object of w.island.root.children) {
        if (object !== w.island.sky.mesh)
            excluded.set(object, object.visible);
    }
    const halos = [];
    w.scene.traverse(object => {
        if (object.name === 'crossing-halo') {
            if (!object.material?.uniforms?.uStreak)
                throw Error('Unexpected crossing-halo material');
            halos.push(object);
            excluded.set(object, object.visible);
        }
    });
    const visibility = () => [...excluded].map(([object]) => ({
        uuid: object.uuid,
        name: object.name,
        type: object.type,
        visible: object.visible
    }));
    const before = {
        camera: {
            position: saved.camera.position.toArray(),
            quaternion: saved.camera.quaternion.toArray(),
            fov: saved.camera.fov
        },
        time: saved.time,
        stationTime: saved.stationTime,
        walking: saved.walking,
        wet: originalWet,
        skyEnv: saved.sky,
        glass: [...glass].map(([m, v]) => ({ uuid: m.uuid, visible: v })),
        excludedVisibility: visibility(),
        captureStats: JSON.parse(JSON.stringify(ref.stats))
    };
    const target = new T.WebGLRenderTarget(256, 256, {
        type: T.HalfFloatType,
        format: T.RGBAFormat,
        generateMipmaps: false,
        minFilter: T.LinearFilter,
        magFilter: T.LinearFilter,
        depthBuffer: true
    });
    const axes = new T.CubeCamera(.18, 84, null);
    axes.coordinateSystem = r.coordinateSystem;
    axes.updateCoordinateSystem();
    axes.position.copy(origin).applyMatrix4(s.root.matrixWorld);
    axes.layers.enableAll();
    axes.updateMatrixWorld(true);
    // CubeCamera r187 uses negative x/y focal lengths. A local Z half-turn
    // plus a conventional positive projection preserves every sampled ray,
    // while screen-size shaders receive the positive focal length they expect.
    const halfTurn = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 0, 1), Math.PI);
    const cameras = axes.children.map(child => {
        const camera = new T.PerspectiveCamera(90, 1, .18, 84);
        child.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);
        camera.quaternion.multiply(halfTurn);
        camera.coordinateSystem = r.coordinateSystem;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        camera.layers.enableAll();
        return camera;
    });
    const labels = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
    function dir(c, x, y) {
        return new T.Vector3(x, y, .5).unproject(c).sub(c.getWorldPosition(new T.Vector3())).normalize();
    }
    const rayEquivalence = cameras.map((camera, i) => {
        const dots = [];
        for (const x of [-1, 0, 1]) {
            for (const y of [-1, 0, 1])
                dots.push(dir(camera, x, y).dot(dir(axes.children[i], x, y)));
        }
        return { face: labels[i], minDot: Math.min(...dots) };
    });
    if (rayEquivalence.some(row => row.minDot < 1 - 1e-10))
        throw Error('Positive-projection camera differs from CubeCamera rays');
    const edgeRows = cameras.flatMap((c, i) => [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([x, y]) => ({
        face: labels[i],
        ndc: [x, y],
        direction: dir(c, x, y).toArray()
    })));
    const edges = edgeRows.map(a => {
        let best = null;
        for (const b of edgeRows) {
            if (a.face === b.face)
                continue;
            const dot = new T.Vector3(...a.direction).dot(new T.Vector3(...b.direction));
            if (!best || dot > best.dot)
                best = {
                    face: b.face,
                    ndc: b.ndc,
                    dot
                };
        }
        return { ...a, neighbor: best };
    });
    let restored = false;
    function restore() {
        if (restored)
            return { alreadyRestored: true };
        restored = true;
        r.setRenderTarget(saved.target, saved.face, saved.mip);
        r.xr.enabled = saved.xr;
        r.shadowMap.autoUpdate = saved.auto;
        r.shadowMap.needsUpdate = saved.needs;
        for (const [m, v] of glass)
            m.visible = v;
        for (const [object, visible] of excluded)
            object.visible = visible;
        w.island.sky.material.uniforms.uEnv.value = saved.sky;
        s.wetRoad.setEnabled(originalWet);
        w.walker.setEnabled(saved.walking);
        w.camera.copy(saved.camera);
        w.camera.updateMatrixWorld();
        s.update(0, saved.stationTime, w.walker.worldPosition);
        w.island.update(0, saved.time);
        w.island.U.uTime.value = saved.time;
        w.look.pipeline.hasPrev = false;
        target.dispose();
        gate.resume();
        const after = {
            camera: {
                position: w.camera.position.toArray(),
                quaternion: w.camera.quaternion.toArray(),
                fov: w.camera.fov
            },
            time: w.island.U.uTime.value,
            stationTime: s.ctx.time,
            walking: w.walker.enabled,
            wet: s.wetRoad.enabled,
            skyEnv: w.island.sky.material.uniforms.uEnv.value,
            glass: [...glass].map(([m]) => ({ uuid: m.uuid, visible: m.visible })),
            excludedVisibility: visibility(),
            captureStats: JSON.parse(JSON.stringify(ref.stats))
        };
        return {
            before,
            after,
            equal: JSON.stringify(before) === JSON.stringify(after),
            glError: gl.getError(),
            gateResumed: !gate.frozen
        };
    }
    window.__streetBake = { restore, bakeFace(index) {
            const camera = cameras[index];
            w.camera.copy(camera);
            w.camera.updateMatrixWorld();
            if (w.camera.position.distanceTo(axes.position) > 1e-6)
                throw Error('Face camera position must match reflection origin before island uniform update');
            s.update(0, 14, w.walker.worldPosition);
            w.island.update(0, 14);
            w.island.U.uTime.value = 14;
            r.setRenderTarget(target);
            r.clear(true, true, true);
            r.render(w.scene, camera);
            const bits = new Uint16Array(256 * 256 * 4);
            r.readRenderTargetPixels(target, 0, 0, 256, 256, bits);
            const error = gl.getError();
            if (error)
                throw Error('Bake readback GL error ' + error);
            const roundTripMax = [0, 0, 0], roundTripSum = [0, 0, 0];
            let limitedPixels = 0, mappedPeak = 0, maxEncodingError = 0;
            const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], sum = [0, 0, 0], negative = [0, 0, 0], over2 = [0, 0, 0], nonFinite = [0, 0, 0];
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 256;
            const context = canvas.getContext('2d'), image = context.createImageData(256, 256);
            for (let i = 0; i < bits.length; i += 4) {
                const red = T.DataUtils.fromHalfFloat(bits[i]);
                const green = T.DataUtils.fromHalfFloat(bits[i + 1]);
                const blue = T.DataUtils.fromHalfFloat(bits[i + 2]);
                const peak = Math.max(red, green, blue);
                // The cube decodes to [0,2]. Limit all channels together so bright coloured lamps retain their hue.
                const gain = peak > 2 ? 2 / peak : 1;
                if (peak > 2) limitedPixels++;
                const rgb = [red, green, blue];
                for (let k = 0; k < 3; k++) {
                    const v = rgb[k];
                    if (!Number.isFinite(v))
                        nonFinite[k]++;
                    else {
                        min[k] = Math.min(min[k], v);
                        max[k] = Math.max(max[k], v);
                        sum[k] += v;
                        if (v < 0)
                            negative[k]++;
                        if (v > 2)
                            over2[k]++;
                    }
                    const mapped = v * gain;
                    mappedPeak = Math.max(mappedPeak, mapped);
                    const x = mapped / 2;
                    image.data[i + k] = Math.round(255 * (x <= .0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - .055));
                    const encoded = image.data[i + k] / 255;
                    const decoded = 2 * (encoded <= .04045 ? encoded / 12.92 : Math.pow((encoded + .055) / 1.055, 2.4));
                    maxEncodingError = Math.max(maxEncodingError, Math.abs(decoded - mapped));
                    const error = Math.abs(decoded - v);
                    roundTripMax[k] = Math.max(roundTripMax[k], error);
                    roundTripSum[k] += error;
                }
                image.data[i + 3] = 255;
            }
            context.putImageData(image, 0, 0);
            const bytes = new Uint8Array(bits.buffer);
            let raw = '';
            for (let i = 0; i < bytes.length; i += 8192)
                raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
            const samples = [[128, 32], [64, 32], [192, 32], [128, 64], [128, 96], [144, 127], [200, 80]].map(([x, y]) => ({
                x,
                y,
                linearRGB: [0, 1, 2].map(k => T.DataUtils.fromHalfFloat(bits[(y * 256 + x) * 4 + k]))
            }));
            return {
                name: labels[index],
                png: canvas.toDataURL('image/png'),
                halfFloatBase64: btoa(raw),
                min,
                max,
                mean: sum.map(x => x / 65536),
                negative,
                nonFinite,
                over2,
                over2Fraction: over2.map(x => x / 65536),
                limitedPixels, mappedPeak, maxEncodingError,
                samples,
                quantization: {
                    maxAbsLinearError: roundTripMax,
                    meanAbsLinearError: roundTripSum.map(x => x / 65536),
                    includesRangeClipping: true
                },
                glError: error,
                time: w.island.U.uTime.value,
                camera: {
                    matrixWorld: camera.matrixWorld.toArray(),
                    projectionMatrix: camera.projectionMatrix.toArray(),
                    direction: dir(camera, 0, 0).toArray()
                },
                render: { ...r.info.render }
            };
        } };
    gate.freeze();
    w.walker.setEnabled(false);
    s.wetRoad.setEnabled(false);
    for (const m of glass.keys())
        m.visible = false;
    for (const object of excluded.keys())
        object.visible = false;
    w.island.sky.material.uniforms.uEnv.value = 1;
    r.xr.enabled = false;
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = true;
    return {
        before,
        captureScope: 'Station scene and procedural sky only. All other direct island children and crossing lens halos are temporarily hidden; physical traffic lamps remain.',
        exclusions: visibility(),
        excludedHaloCount: halos.length,
        rayEquivalence,
        origin: {
            stationLocal: localOrigin,
            world: axes.position.toArray(),
            source: 'streetReflections.uniforms.uStreetOrigin: streetCenterX(18), layout.heightAt(x,18)+1.9, z18'
        },
        edges,
        edgesMatch: edges.every(x => x.neighbor.dot > 1 - 1e-10),
        dimensions: [256, 256],
        type: 'RGBA binary16 HalfFloat; independent 2D target per face render, no mipmaps',
        encoding: 'PNG RGB8 = sRGB(linearRGB / max(2, peakRGB)); alpha255. Linear radiance up to 2 is preserved, brighter texels retain RGB ratios. Bottom row0 is PNG row0, no flip. Runtime sRGB decode *2 with CubeTexture.flipY=false; face order px,nx,py,ny,pz,nz.',
        sourceStats: JSON.parse(JSON.stringify(ref.stats))
    };
}
async function host() {
    const { app, BrowserWindow } = require('electron'), config = JSON.parse(fs.readFileSync(process.argv[2]));
    app.setPath('userData', path.join(config.runtime, 'user-data'));
    app.commandLine.appendSwitch('force-device-scale-factor', '1');
    const report = {
        config,
        stage: 'bootstrap',
        faces: [],
        console: [],
        exceptions: [],
        networkFailures: [],
        httpErrors: [],
        ok: false
    };
    const write = () => fs.writeFileSync(path.join(config.output, 'bake-report.json'), JSON.stringify(report, null, 2));
    const stage = s => {
        report.stage = s;
        write();
    };
    let win, server, timer;
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Bake timeout at ' + report.stage)), config.timeoutMs);
    });
    try {
        await Promise.race([(async () => {
                write();
                await app.whenReady();
                stage('app-ready');
                server = createStaticServer(fixture);
                await new Promise((resolve, reject) => {
                    server.once('error', reject);
                    server.listen(0, '127.0.0.1', resolve);
                });
                win = new BrowserWindow({
                    width: 1440,
                    height: 900,
                    useContentSize: true,
                    show: true,
                    title: 'Offline street reflection bake',
                    webPreferences: {
                        sandbox: true,
                        nodeIntegration: false,
                        contextIsolation: true,
                        backgroundThrottling: false
                    }
                });
                await win.loadURL('about:blank');
                win.webContents.debugger.attach('1.3');
                const cdp = (m, p) => win.webContents.debugger.sendCommand(m, p);
                const rows = new Map();
                win.webContents.on('console-message', (_event, level, message) => {
                    if (level >= 2)
                        report.console.push({
                            stage: report.stage,
                            level,
                            message
                        });
                });
                win.webContents.debugger.on('message', (_event, method, params) => {
                    if (method === 'Runtime.exceptionThrown')
                        report.exceptions.push(params);
                    if (method === 'Network.requestWillBeSent')
                        rows.set(params.requestId, params.request.url);
                    if (method === 'Network.responseReceived' && params.response.status >= 400) {
                        report.httpErrors.push({
                            requestId: params.requestId,
                            url: params.response.url,
                            status: params.response.status,
                            stage: report.stage
                        });
                    }
                    if (method === 'Network.loadingFailed') {
                        report.networkFailures.push({
                            url: rows.get(params.requestId),
                            ...params,
                            stage: report.stage
                        });
                    }
                });
                await cdp('Page.enable');
                await cdp('Runtime.enable');
                await cdp('Network.enable');
                await cdp('Page.addScriptToEvaluateOnNewDocument', { source: '(' + installGate.toString() + ')()' });
                stage('loading');
                await win.loadURL('http://127.0.0.1:' + server.address().port + '/');
                const evaluate = x => win.webContents.executeJavaScript(x, true);
                while (!await evaluate('window.worldBase?.ready===true')) {
                    const errors = await evaluate('window.worldBase?.errors||[]');
                    if (errors.length)
                        throw Error(errors.join('\n'));
                    await pause(100);
                }
                report.readyClock = await evaluate('({timeOrigin:performance.timeOrigin,now:performance.now()})');
                stage('preparing');
                report.preparation = await evaluate('(' + prepareBake.toString() + ')()');
                write();
                for (let i = 0; i < 6; i++) {
                    stage('face-' + i);
                    const face = await evaluate('window.__streetBake.bakeFace(' + i + ')');
                    const png = Buffer.from(face.png.split(',')[1], 'base64'), raw = Buffer.from(face.halfFloatBase64, 'base64');
                    delete face.png;
                    delete face.halfFloatBase64;
                    face.file = face.name + '.png';
                    face.sha256 = hash(png);
                    face.rawFile = face.name + '.rgba16f';
                    face.rawSha256 = hash(raw);
                    fs.writeFileSync(path.join(config.output, face.file), png);
                    fs.writeFileSync(path.join(config.output, face.rawFile), raw);
                    report.faces.push(face);
                    write();
                    if (face.nonFinite.some(n => n > 0))
                        throw Error('Non-finite HDR texels in ' + face.name);
                }
                report.rangeUnclipped = report.faces.every(f => f.negative.every(n => n === 0) && f.over2.every(n => n === 0));
                report.bakeValid = report.faces.length === 6 && report.preparation.edgesMatch && report.faces.every(f => f.glError === 0 && !f.nonFinite.some(Boolean));
                // Half an sRGB8 step at the bright end is less than .009 linear at this scale.
                report.encodingValid = report.bakeValid && report.faces.every(f => f.negative.every(n => n === 0) &&
                    f.mappedPeak <= 2 && f.maxEncodingError < .009);
                await pause(3000);
            })(), deadline]);
    }
    catch (e) {
        report.failure = e.stack || String(e);
        console.error(e);
    }
    finally {
        clearTimeout(timer);
        if (win && !win.isDestroyed()) {
            try {
                report.restore = await win.webContents.executeJavaScript('window.__streetBake?.restore()');
            }
            catch (e) {
                report.restoreFailure = String(e);
            }
            win.destroy();
        }
        server?.close();
        const original = JSON.parse(fs.readFileSync(path.join(config.output, 'source-manifest.json'))), current = sceneFiles();
        report.changedFiles = [...new Set([...Object.keys(original.files), ...Object.keys(current)])].filter(p => original.files[p] !== current[p]);
        report.sourceUnchanged = !report.changedFiles.length && head() === config.head;
        report.driverUnchanged = hash(fs.readFileSync(__filename)) === config.driverSha256;
        const assets = JSON.parse(fs.readFileSync(path.join(config.output, 'prop-assets-manifest.json')));
        report.assetsUnchanged = assets.files.every(f => hash(fs.readFileSync(path.join(fixture, f.path))) === f.sha256);
        report.transportClean = !report.networkFailures.length && !report.httpErrors.length;
        report.ok = report.encodingValid && report.restore?.equal && report.sourceUnchanged && report.driverUnchanged && report.assetsUnchanged && report.transportClean && !report.exceptions.length && !report.failure && !report.restoreFailure;
        report.stage = 'complete';
        report.completedAt = new Date().toISOString();
        write();
        app.exit(report.ok ? 0 : 1);
    }
}
const direct = require.main === module || (process.versions.electron && process.argv[1] && path.resolve(process.argv[1]) === __filename);
if (direct) {
    if (process.versions.electron)
        host().catch(e => {
            console.error(e);
            require('electron').app.exit(1);
        });
    else
        try {
            launch();
        }
        catch (e) {
            console.error(e);
            process.exitCode = 1;
        }
}
