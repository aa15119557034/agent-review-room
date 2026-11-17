const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
const head = '7d362bc069b20c8e38fdf776c4eac5e87b0081ec';
const job = read('x51-c14-ci-jobs.json').jobs.find(item => item.id === 134045769501);
const log = read('x51-c14-ci-log.json');
if (!job || job.head_sha !== head || typeof log !== 'string') throw new Error('Unexpected C14 CI input');
const rows = log.split(/\r?\n/).filter(line => /\{"name":"(?:tests-|types-|build-)/.test(line)).map(line => JSON.parse(line.slice(line.indexOf('{'))));
const tests = rows.filter(row => row.name.startsWith('tests-'));
const summary = { head, run: 44085220238, job: job.id, url: job.html_url, result: job.conclusion, completedAt: job.completed_at,
  tests: tests.reduce((sum, row) => sum + row.tests, 0), passed: tests.reduce((sum, row) => sum + row.pass, 0),
  types: rows.filter(row => row.name.startsWith('types-')).length, builds: rows.filter(row => row.name.startsWith('build-')).length,
  allExitZero: rows.length > 0 && rows.every(row => row.code === 0), rows,
  source: 'Read-only GitHub REST check-runs, jobs and actual job log; no GitHub write or local test execution.',
  logSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'x51-c14-ci-log.json'))).digest('hex') };
fs.writeFileSync(path.join(__dirname, 'x51-c14-ci-summary.json'), JSON.stringify(summary, null, 2) + '\n');
const { rows: omitted, ...brief } = summary; console.log(JSON.stringify(brief, null, 2));
if (job.conclusion !== 'success' || tests.length !== 9 || rows.length !== 20 || new Set(rows.map(row => row.name)).size !== 20 || !summary.tests || summary.tests !== summary.passed || summary.types !== 9 || summary.builds !== 2 || !summary.allExitZero) throw new Error('C14 Windows log is incomplete or did not pass; actual summary was saved');
