// Verify pinned local originals and copy only runtime dependencies into ignored .local/city.
// No network, asset conversion, package installation, or renderer is involved.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'city-assets.json'), 'utf8'));
const output = path.join(root, '.local', 'city');
const usage = 'node scripts/prepare-city.cjs --downtown=<extracted Standard directory> --highrise=<original GLB path>\nWithout arguments, verify both prepared asset sets. One source argument prepares only that asset set.\nOfficial acquisition steps and pinned hashes are in city-assets.json; --download is not implemented.';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function within(base, relative) {
  const resolved = path.resolve(base, relative);
  const rel = path.relative(base, resolved);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Asset path escapes its root: ${relative}`);
  }
  return resolved;
}

function verify(file, expected) {
  if (!fs.existsSync(file)) throw new Error(`Missing asset: ${file}`);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size !== expected.bytes || hash(file) !== expected.sha256) {
    throw new Error(`Pinned asset mismatch: ${file}; expected ${expected.bytes} bytes / SHA-256 ${expected.sha256}. Existing files were preserved.`);
  }
}

function verifyReferences(plan) {
  const destinations = new Set(plan.map(file => file.destination));
  for (const file of plan) {
    const source = file.source || file.destination;
    let json;
    if (file.destination.endsWith('.gltf')) {
      json = JSON.parse(fs.readFileSync(source, 'utf8'));
    } else if (file.destination.endsWith('.glb')) {
      const buffer = fs.readFileSync(source);
      if (buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length || buffer.readUInt32LE(16) !== 0x4e4f534a) {
        throw new Error(`Invalid glTF 2.0 binary header: ${source}`);
      }
      json = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString('utf8'));
    } else continue;
    for (const item of [...(json.buffers || []), ...(json.images || [])]) {
      if (!item.uri) continue; // Embedded GLB resources.
      if (/^(?:[a-z]+:|\/|\\)/i.test(item.uri)) throw new Error(`Unexpected non-local dependency in ${source}: ${item.uri}`);
      const target = within(path.dirname(file.destination), decodeURIComponent(item.uri));
      if (!destinations.has(target)) throw new Error(`Dependency omitted from the pinned copy list: ${item.uri} (${source})`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const sources = new Map();
  for (const arg of args) {
    const match = /^--(downtown|highrise)=(.+)$/.exec(arg);
    if (!match || sources.has(match[1])) throw new Error(`Unknown, empty or duplicate argument: ${arg}\n${usage}`);
    sources.set(match[1], path.resolve(match[2]));
  }
  const projects = sources.size ? [...sources.keys()] : Object.keys(manifest.projects);
  const plan = [];
  for (const name of projects) {
    const project = manifest.projects[name];
    const input = sources.get(name);
    if (input && (!fs.existsSync(input) || (project.sourceType === 'directory' ? !fs.statSync(input).isDirectory() : !fs.statSync(input).isFile()))) {
      throw new Error(`Expected ${project.sourceType} for --${name}: ${input}`);
    }
    for (const expected of project.files) {
      const destination = within(output, expected.destination);
      const source = input ? (project.sourceType === 'file' ? input : within(input, expected.sourcePath)) : null;
      // Preflight every source and existing destination before creating any output.
      if (source) verify(source, expected);
      if (!source || fs.existsSync(destination)) verify(destination, expected);
      plan.push({ name, expected, source, destination });
    }
  }
  verifyReferences(plan);
  let copied = 0;
  for (const file of plan) {
    if (!file.source || fs.existsSync(file.destination)) continue;
    fs.mkdirSync(path.dirname(file.destination), { recursive: true });
    const part = `${file.destination}.part`;
    let created = false;
    try {
      fs.copyFileSync(file.source, part, fs.constants.COPYFILE_EXCL);
      created = true;
      verify(part, file.expected);
      fs.renameSync(part, file.destination);
      created = false;
      copied++;
    } finally {
      if (created) fs.unlinkSync(part);
    }
  }
  for (const file of plan) verify(file.destination, file.expected);
  console.log(`${projects.join(', ')}: ${plan.length} pinned files verified; ${copied} copied into .local/city. Original bytes and glTF relative references preserved.`);
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
