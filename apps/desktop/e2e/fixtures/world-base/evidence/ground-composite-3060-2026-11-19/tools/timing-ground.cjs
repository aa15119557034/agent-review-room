'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const child = require('node:child_process');
const assert = require('node:assert/strict');
const fixture = path.resolve(process.env.WORLD_FIXTURE);
const historic = path.join(fixture, 'evidence/plaza-final-ground-3060-2026-11-19/tools/timing.cjs');
let body = fs.readFileSync(historic, 'utf8').replaceAll('\r\n', '\n');
function edit(from, to) {
  assert.equal(body.split(from).length, 2, from);
  body = body.replace(from, () => to);
}
edit("'src','scripts/baseline.cjs'", "'src','upstream/petalwake/src/core/pipeline.js','scripts/baseline.cjs'");
const hostEdits = [
  ['show: true, autoHideMenuBar: true', 'show: false, autoHideMenuBar: true'],
  ["  stage('window-created');", "  win.showInactive();\n  stage('window-created');"],
  ['win.focus(); win.webContents.focus();',
    "const walkingKey = type => cdp('Input.dispatchKeyEvent',{type,key:'w',code:'KeyW',windowsVirtualKeyCode:87,nativeVirtualKeyCode:87});"],
  ["win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });","await walkingKey('keyDown');"],
  ["finally { win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' }); }","finally { await walkingKey('keyUp'); }"],
  ["        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });",
    "        await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'w',code:'KeyW',windowsVirtualKeyCode:87,nativeVirtualKeyCode:87});"],
  ['Electron sendInputEvent holds W', 'Chromium Input.dispatchKeyEvent holds trusted W'],
];
const insertion = "write('source-manifest.json',source);";
edit(insertion,hostEdits.map(([a,b]) => 'once('+JSON.stringify(a)+','+JSON.stringify(b)+');').join('\n')+'\n'+insertion);
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'ground-composite-timing-'));
const script = path.join(temp, 'measure.cjs');
try {
  fs.writeFileSync(script,body,{flag:'wx'});
  child.execFileSync(process.execPath,[script,...process.argv.slice(2)],{cwd:fixture,env:process.env,windowsHide:true,stdio:'inherit'});
} finally {
  fs.unlinkSync(script);
  fs.rmdirSync(temp);
}
