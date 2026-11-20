const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
const head = '96ddf39ce4ca6448acf1a59dcc49dbf4ca4908ac';
const job = read('x51-c15-source-ci-jobs.json').jobs.find(item => item.id === 134092853043);
const log = read('x51-c15-source-ci-log.json');
if (!job || job.head_sha !== head || typeof log !== 'string') throw new Error('Unexpected C15 CI input');
const rows = log.split(/\r?\n/).filter(line => /\{"name":"(?:tests-|types-|build-)/.test(line)).map(line => JSON.parse(line.slice(line.indexOf('{'))));
const tests = rows.filter(row => row.name.startsWith('tests-'));
const checkoutMatch = log.match(/origin \+([a-f0-9]{40}):refs\/remotes\/pull\/254\/merge/);
const mergeMatch = log.match(/HEAD is now at [a-f0-9]+ Merge ([a-f0-9]{40}) into ([a-f0-9]{40})/);
if (!checkoutMatch || !mergeMatch || mergeMatch[1] !== head) throw new Error('Unexpected PR checkout provenance');
const summary = { head, actualCheckout: { ref: 'refs/remotes/pull/254/merge', sha: checkoutMatch[1], sourceHead: mergeMatch[1], baseHead: mergeMatch[2], scope: 'CI is associated with exact API head_sha; actual tested checkout is GitHub PR synthetic merge, not direct source-head checkout.' }, run: 44098778204, job: job.id, url: job.html_url, result: job.conclusion, completedAt: job.completed_at,
  tests: tests.reduce((sum, row) => sum + row.tests, 0), passed: tests.reduce((sum, row) => sum + row.pass, 0),
  types: rows.filter(row => row.name.startsWith('types-')).length, builds: rows.filter(row => row.name.startsWith('build-')).length,
  allExitZero: rows.length > 0 && rows.every(row => row.code === 0), rows,
  source: 'Read-only GitHub REST check-runs, jobs and actual job log; no GitHub write or local test execution.',
  logSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'x51-c15-source-ci-log.json'))).digest('hex') };
fs.writeFileSync(path.join(__dirname, 'x51-c15-source-ci-summary.json'), JSON.stringify(summary, null, 2) + '\n');
const { rows: omitted, ...brief } = summary; console.log(JSON.stringify(brief, null, 2));
if (job.conclusion !== 'success' || tests.length !== 9 || rows.length !== 20 || new Set(rows.map(row => row.name)).size !== 20 || !summary.tests || summary.tests !== summary.passed || summary.types !== 9 || summary.builds !== 2 || !summary.allExitZero) throw new Error('C15 Windows log is incomplete or did not pass; actual summary was saved');
