// Launch with Electron and set X51_KONBINI_TARGET and X51_KONBINI_OUTPUT.
if (process.type === 'renderer') {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, options) {
    if (type.startsWith('webgl')) options = { ...options, preserveDrawingBuffer: true };
    return originalGetContext.call(this, type, options);
  };
  let seed = 0x254;
  Math.random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const requestFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => requestFrame(() => callback(5000));
  performance.now = () => 5000;
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const { X51_KONBINI_TARGET: baseURL, X51_KONBINI_OUTPUT: outputArg, X51_KONBINI_MODE: mode = 'capture' } = process.env;
  if (!baseURL || !outputArg || !['capture', 'timing', 'all'].includes(mode)) {
    throw new Error('Set X51_KONBINI_TARGET and X51_KONBINI_OUTPUT, and choose capture, timing or all in X51_KONBINI_MODE');
  }
  const output = path.resolve(outputArg);
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(output, 'browser-profile'));
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.on('window-all-closed', () => {});

  async function probe(capture, timing) {
    const wb = window.worldBase, { camera, renderer, station, walker } = wb;
    const THREE = await import('/upstream/petalwake/vendor/three/build/three.module.js');
    const { lotById, lotFrame } = await import('/upstream/sakuragaoka/src/world/layout.js');
    const frame = lotFrame(lotById('W1')), c = Math.cos(frame.rotY), s = Math.sin(frame.rotY);
    const lotPoint = (x, y, z) => new THREE.Vector3(frame.x + c*x + s*z, frame.y+y, frame.z - s*x + c*z);
    const feet = () => {
      const x = walker.position.x-frame.x, z = walker.position.z-frame.z;
      return [c*x-s*z, walker.position.y-frame.y, s*x+c*z];
    };
    const room = station.root.getObjectByName('w1-authored-interior');
    const door = station.root.getObjectByName('w1-auto-door');
    if (!room || !door) throw new Error('W1 authored geometry or sliding door missing');
    const panels = () => door.children.map(panel => panel.position.x);
    const aisleResults = [];
    const shots = [];
    const measurements = [];
    renderer.setPixelRatio(1);
    renderer.setSize(1440, 900, false);
    const gl = renderer.getContext();
    const adapter = gl.getExtension('WEBGL_debug_renderer_info');
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');

    const frames = (count, onFrame = () => {}) => new Promise(resolve => {
      const tick = () => {
        onFrame();
        if (--count) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    const snap = async (name) => {
      await frames(18);
      shots.push({ name, png: renderer.domElement.toDataURL('image/png').split(',')[1],
        eye: camera.position.toArray(), rotation: camera.quaternion.toArray(), fov: camera.fov });
    };
    const walkTo = (x, z, yaw, pitch = 0) => {
      const local = lotPoint(x, 4, z);
      local.y = station.physics.groundHeight(local.x, local.z, local.y);
      walker.setPose(station.toWorld(local), frame.rotY*180/Math.PI+yaw, pitch);
      station.update(0, 5, walker.worldPosition);
    };
    const hold = (code, count, until = () => false) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      try {
        for (let index = 0; index < count && !until(); index++) {
          station.update(1/60, 5, walker.worldPosition);
          walker.update(1/60);
        }
      } finally {
        window.dispatchEvent(new KeyboardEvent('keyup', { code }));
      }
      station.update(0, 5, walker.worldPosition);
    };
    const entry = () => {
      wb.startWalking();
      walker.setView('first');
      walkTo(1.0, .8, 0, -4);
      const outside = { feet: feet(), panels: panels() };
      hold('KeyW', 140, () => feet()[2] <= -4.0);
      const inside = { feet: feet(), panels: panels() };
      if (inside.feet[2] > -3.8 || Math.abs(inside.feet[1]-.30) > .07 || inside.panels[1] - inside.panels[0] < 2.4) {
        throw new Error('W1 automatic entry failed: '+JSON.stringify({ outside, inside }));
      }
      return { outside, inside };
    };
    const lookAtInRoom = (x, z, toX, toZ, pitch, fov) => {
      camera.fov = fov;
      camera.updateProjectionMatrix();
      walkTo(x, z, Math.atan2(x-toX,z-toZ)*180/Math.PI, pitch);
    };
    async function gpuFrames(view, round) {
      await frames(60);
      if (!ext) throw new Error('Missing EXT_disjoint_timer_query_webgl2');
      const jobs = [];
      let frame = 0;
      const render = renderer.render;
      renderer.render = function (...args) {
        const query = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
        try {
          return render.apply(this, args);
        } finally {
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          jobs.push({ query, frame });
        }
      };
      try {
        await frames(120, () => frame++);
      } finally {
        renderer.render = render;
      }
      let disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      for (let retries = 0; retries < 50 && !disjoint; retries++) {
        if (jobs.every(({query}) => gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE))) break;
        await new Promise(resolve => setTimeout(resolve, 60));
        disjoint ||= gl.getParameter(ext.GPU_DISJOINT_EXT);
      }
      const totals = new Map();
      for (const { query, frame } of jobs) {
        if (!disjoint && frame > 0 && frame < 119 && gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
          totals.set(frame, (totals.get(frame) ?? 0) + gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
        }
        gl.deleteQuery(query);
      }
      const ms = [...totals.values()].sort((a,b) => a-b);
      if (ms.length < 100) throw new Error('Insufficient valid GPU samples for '+view);
      measurements.push({ view, round, frameCount: ms.length, p95: ms[Math.ceil(ms.length*.95)-1],
        calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, frameGpuMs: [...totals.values()] });
    }
    const timeOfDay = wb.island.timeOfDay;
    if (capture) {
      wb.setView('art-b-konbini');
      await snap('B');
      aisleResults.push(entry());
      await snap('entry');
      hold('KeyW', 180);
      const cooler = feet();
      aisleResults.push({ cooler, panels: panels() });
      if (cooler[2] < -10.9 || cooler[2] > -10.3) throw new Error('W1 cooler collider failed: '+JSON.stringify(cooler));
      lookAtInRoom(-1.45,-9.9,-4.35,-5.45,-5,67);
      await snap('checkout');
      lookAtInRoom(3.72,-9.75,2.01,-3.1,-6,65);
      await snap('magazines');
      // Walk through the door in reverse using the same physical player.
      walkTo(1.0,-4.2,180,0);
      hold('KeyW',130,() => feet()[2] > 0);
      const returned = { feet: feet(), panels: panels() };
      aisleResults.push({ returned });
      if (returned.feet[2] <= -.3) throw new Error('W1 exit failed: '+JSON.stringify(returned));
    }
    if (timing) {
      for (let round = 1; round <= 3; round++) {
        wb.setView('art-b-konbini');
        await gpuFrames('B', round);
        aisleResults.push(entry());
        await gpuFrames('entry', round);
      }
    }
    return {
      timeOfDay,
      renderer: adapter && gl.getParameter(adapter.UNMASKED_RENDERER_WEBGL),
      glError: gl.getError(),
      worldErrors: wb.errors,
      decals: { source: wb.weatheringDecals.stats.source, fingerprint: wb.weatheringDecals.plan.fingerprint },
      fixtures: room.children.map(child => child.name),
      spill: wb.shopSpill?.fronts.filter(front => front.name.startsWith('W1')).map(front => ({
        name: front.name, depth: front.depth, width: front.width, triangles: front.index.length/3,
      })),
      aisleResults, measurements, shots,
    };
  }

  async function run(timeOfDay) {
    const pageErrors = [];
    const window = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false,
      webPreferences: { offscreen: true, backgroundThrottling: false, preload: __filename, contextIsolation: false },
    });
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') pageErrors.push(event.message);
      if (event.message?.startsWith('[world-base]')) console.log(event.message);
    });
    try {
      const url = new URL(baseURL);
      url.searchParams.set('time', timeOfDay);
      console.log('[konbini] opening', url.href, mode);
      await window.loadURL(url.href);
      for (let attempt = 0; attempt < 480; attempt++) {
        const status = await window.webContents.executeJavaScript('({ready: window.worldBase?.ready, errors: window.worldBase?.errors})');
        if (status.errors?.length) throw new Error(status.errors.join('\n'));
        if (status.ready) break;
        if (attempt === 479) throw new Error('W1 fixture did not become ready');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const result = await window.webContents.executeJavaScript(
        '('+probe.toString()+')('+(mode !== 'timing')+','+(mode !== 'capture')+')');
      for (const shot of result.shots) {
        fs.writeFileSync(path.join(output, timeOfDay+'-'+shot.name+'.png'), Buffer.from(shot.png, 'base64'));
        delete shot.png;
      }
      fs.writeFileSync(path.join(output, timeOfDay+'.json'), JSON.stringify({ ...result, pageErrors }, null, 2));
      if (pageErrors.length || result.glError || result.worldErrors.length) throw new Error(JSON.stringify({pageErrors,...result}));
      console.log('[konbini]', timeOfDay, result.renderer, JSON.stringify({ spill: result.spill, aisle: result.aisleResults,
        gpu: result.measurements.map(({view,round,p95,frameCount}) => [view,round,p95,frameCount]) }));
    } finally {
      window.destroy();
    }
  }

  app.whenReady().then(async () => {
    for (const time of ['night','evening']) await run(time);
    app.exit(0);
  }).catch(error => {
    console.error(error);
    fs.writeFileSync(path.join(output, 'error.txt'), error.stack || String(error));
    app.exit(1);
  });
}
