const { execFileSync } = require('node:child_process');

function listZip(archive) {
  const bytes = process.platform === 'win32'
    ? execFileSync('tar.exe', ['-tf', archive], {windowsHide: true})
    : execFileSync('unzip', ['-Z1', archive]);
  return bytes.toString('utf8').trimEnd().split(/\r?\n/);
}

function readZipEntry(archive, entry) {
  return process.platform === 'win32'
    ? execFileSync('tar.exe', ['-xOf', archive, entry], {windowsHide: true})
    : execFileSync('unzip', ['-p', archive, entry]);
}

function extractZip(archive, destination, entries = []) {
  if (process.platform === 'win32') {
    execFileSync('tar.exe', ['-xf', archive, '-C', destination, ...entries], {windowsHide: true});
  } else {
    execFileSync('unzip', ['-oq', archive, ...entries, '-d', destination]);
  }
}

module.exports = {listZip, readZipEntry, extractZip};
