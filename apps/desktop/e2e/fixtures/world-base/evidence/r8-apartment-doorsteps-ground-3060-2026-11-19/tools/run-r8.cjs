'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [runtime, tag = 'r8-native-1119'] = process.argv.slice(2);
if (!runtime) throw new Error('Pass the absolute path to Electron 44.9.0.');
const root = path.dirname(__dirname);
const fixture = 'apps/desktop/e2e/fixtures/world-base';
const before = path.join(root, 'x51-r7-after', fixture);
const after = path.join(root, 'x51-r8-after', fixture);
const audit = path.join('D:/codex/2026-11-16/world-implementation/world-request-audit', fixture);

const run = spawnSync(process.execPath, [
  path.join(__dirname, 'measure-ground.cjs'), before, after, audit, path.resolve(runtime), tag,
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
