'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync,execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

const [exe, fixtureArg, outputArg, sha] = process.argv.slice(2);
assert(exe&&fixtureArg&&outputArg&&sha);
const fixture=path.resolve(fixtureArg),out=path.resolve(outputArg);
const root=path.resolve(fixture,'../../../../..').split(path.sep).join('/');
const shaActual=execFileSync('git',['-c','safe.directory='+root,'rev-parse','HEAD'],{cwd:fixture,windowsHide:true,encoding:'utf8'}).trim();
assert.equal(shaActual,sha);
const text=fs.readFileSync(path.join(fixture,'src','door-glow.js'),'utf8');
const match=text.matchAll(/const (VERT|FRAG) = \/\* glsl \*\/\s*`([\s\S]*?)`;/g);
const snippets=Object.fromEntries(Array.from(match,m=>[m[1],m[2]]));
assert(snippets.VERT&&snippets.FRAG);

function compile(snippets) {
  const gl=document.createElement('canvas').getContext('webgl2');
  if (!gl) throw Error('WebGL2 unavailable');
  const ext=gl.getExtension('WEBGL_debug_renderer_info');
  const gpu=ext&&gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  const version=gl.getParameter(gl.VERSION), compiler=gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
  const pre='#version 300 es\nprecision highp float;\nprecision highp int;\n';
  const v=pre+'#define attribute in\n#define varying out\n#define USE_INSTANCING\nattribute vec3 position;\nattribute vec2 uv;\nattribute mat4 instanceMatrix;\nuniform mat4 modelViewMatrix;\nuniform mat4 projectionMatrix;\n';
  const f=pre+'#define varying in\nlayout(location=0) out highp vec4 pc_fragColor;\n#define gl_FragColor pc_fragColor\n';
  const variants={};
  for(const label of ['wall','floor']){
    const vertex=gl.createShader(gl.VERTEX_SHADER),fragment=gl.createShader(gl.FRAGMENT_SHADER),program=gl.createProgram();
    gl.shaderSource(vertex,v+snippets.VERT);gl.compileShader(vertex);
    gl.shaderSource(fragment,f+(label==='floor'?'#define FLOOR\n':'')+snippets.FRAG);gl.compileShader(fragment);
    gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
    variants[label]={
      vertex:{ok:gl.getShaderParameter(vertex,gl.COMPILE_STATUS),log:gl.getShaderInfoLog(vertex)},
      fragment:{ok:gl.getShaderParameter(fragment,gl.COMPILE_STATUS),log:gl.getShaderInfoLog(fragment)},
      link:{ok:gl.getProgramParameter(program,gl.LINK_STATUS),log:gl.getProgramInfoLog(program)},
    };
    gl.deleteProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);
  }
  return {gpu,version,compiler,variants};
}
if (!process.versions.electron) {
  fs.mkdirSync(out);
  const runtime=path.join(out,'runtime');
  fs.mkdirSync(runtime);
  const runner='D:/codex/2026-11-16/world-implementation/world-request-audit/apps/desktop/e2e/fixtures/world-base/scripts/baseline.cjs';
  const { cleanEnvironment }=require(runner);
  const proc=spawnSync(path.resolve(exe),[__filename,...process.argv.slice(2)],{
    env:cleanEnvironment(runtime),cwd:fixture,windowsHide:true,stdio:'inherit',timeout:25000,
  });
  if(proc.error)throw proc.error;
  process.exit(proc.status??1);
}
const {app,BrowserWindow}=require('electron');
app.setPath('userData',path.join(out,'runtime','userData'));
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  try{
    await win.loadURL('about:blank');
    const receipt=await win.webContents.executeJavaScript('('+compile.toString()+')('+JSON.stringify(snippets)+')');
    const result={sha,engine:process.versions.electron,path:'src/door-glow.js',
      sourceSha256:createHash('sha256').update(text).digest('hex'),
      prep:'Three-compatible WebGL2 syntax and builtin declarations only; production shader bodies unchanged.', ...receipt};
    fs.writeFileSync(path.join(out,'shader-probe.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify(result));
    assert.match(result.gpu,/RTX 3060 Laptop GPU.*Direct3D11/);
  }finally{win.destroy();}
}).then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
