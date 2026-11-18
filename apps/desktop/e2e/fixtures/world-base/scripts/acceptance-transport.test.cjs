const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { classifyTransport } = require('./acceptance-transport.cjs');
const { createStaticServer } = require('./baseline.cjs');

const origin = 'http://127.0.0.1:3000';
const asset = '/assets/models/menhir.glb';
const url = origin + asset;
const expected = Buffer.from('model data');
const incorrect = Buffer.from('other data');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function transfer(requestId = '67.150', receipt = 'r0001') {
  const bytes = expected.length;
  return {
    origin,
    failures: [{ requestId, url, type: 'Fetch', errorText: 'net::ERR_ABORTED', canceled: true }],
    httpErrors: [],
    requests: [{
      requestId, url, receipt, type: 'Fetch', method: 'GET', status: 200, terminal: 'failed',
      range: false, partial: false, cached: false, redirected: false,
    }],
    served: [{
      receipt, path: asset, method: 'GET', range: false, status: 200,
      finished: true, declared: bytes, fileBytes: bytes, sha256: digest(expected),
      wireBytes: bytes, wireSHA256: digest(expected),
    }],
    reads: [{
      receipt, path: asset, status: 200, declared: bytes, received: bytes,
      sha256: digest(expected), done: true, aborted: false, readError: null,
    }],
  };
}

function expectRejected(report) {
  assert.equal(report.payloadIntegrityClean, false);
  assert.ok(report.problems.length > 0, 'missing explanation for failed integrity check');
}

test('a complete, local, same-request read preserves the raw cancellation and proves delivery', () => {
  const input = transfer();
  const result = classifyTransport(input);
  assert.equal(result.strictTransportClean, false);
  assert.equal(result.payloadIntegrityClean, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.verifiedCanceled.length, 1);
  assert.equal(input.failures[0].canceled, true);
});

test('a successful HTTP transfer with matching receipts passes both gates', () => {
  const input = transfer();
  input.failures = [];
  input.requests[0].terminal = 'finished';
  const result = classifyTransport(input);
  assert.equal(result.strictTransportClean, true);
  assert.equal(result.payloadIntegrityClean, true);
  assert.deepEqual(result.verifiedCanceled, []);
  assert.deepEqual(result.problems, []);
});

for (const [name, invalidate] of [
  ['absent browser request', x => { x.requests = []; }],
  ['absent origin receipt', x => { x.served = []; }],
  ['absent application receipt', x => { x.reads = []; }],
  ['failed CDP ID differs from the request that returned the body', x => { x.failures[0].requestId = '67.151'; }],
  ['origin did not finish writing', x => { x.served[0].finished = false; }],
  ['server wrote a different number of bytes', x => { x.served[0].wireBytes = expected.length - 1; x.served[0].wireSHA256 = digest(expected); }],
  ['server wrote a same-length wrong body', x => { x.served[0].wireBytes = expected.length; x.served[0].wireSHA256 = digest(incorrect); }],
  ['body reader did not reach EOF', x => { x.reads[0].done = false; }],
  ['truncated application body', x => { x.reads[0].received--; }],
  ['wrong original file length', x => { x.served[0].fileBytes++; }],
  ['reader explicitly aborted despite matching bytes', x => { x.reads[0].aborted = true; }],
  ['read error despite matching bytes', x => { x.reads[0].readError = 'TypeError: Failed to fetch'; }],
  ['missing source length', x => { x.served[0].declared = null; }],
  ['missing application length', x => { x.reads[0].declared = null; }],
  ['browser received no status', x => { x.requests[0].status = null; }],
  ['missing browser terminal', x => { x.requests[0].terminal = null; }],
  ['browser terminal contradicts the recorded cancellation', x => { x.requests[0].terminal = 'finished'; }],
  ['no response receipt header', x => { x.requests[0].receipt = null; }],
  ['CDP network error other than cancellation', x => {
    x.failures[0].errorText = 'net::ERR_CONNECTION_RESET';
    x.failures[0].canceled = false;
  }],
  ['cross-origin fetch even with matching local pathname', x => {
    x.requests[0].url = x.failures[0].url = 'http://127.0.0.1:3001' + asset;
  }],
  ['remote fetch with matching pathname', x => {
    x.requests[0].url = x.failures[0].url = 'https://example.test' + asset;
  }],
  ['browser range request', x => { x.requests[0].range = true; }],
  ['origin range request', x => { x.served[0].range = true; }],
  ['partial response to a full-body request', x => {
    x.requests[0].partial = true;
    x.requests[0].status = x.served[0].status = x.reads[0].status = 206;
  }],
  ['redirected media fetch', x => { x.requests[0].redirected = true; }],
  ['cached media response', x => { x.requests[0].cached = true; }],
  ['unrelated application receipt for the same URL', x => { x.reads[0].receipt = 'rOTHER'; }],
  ['duplicated browser request ID', x => { x.requests.push({ ...x.requests[0] }); }],
  ['duplicated origin receipt', x => { x.served.push({ ...x.served[0] }); }],
  ['duplicated application receipt', x => { x.reads.push({ ...x.reads[0] }); }],
]) {
  test('a canceled transfer fails closed for ' + name, () => {
    const input = transfer();
    invalidate(input);
    const report = classifyTransport(input);
    assert.equal(report.strictTransportClean, false);
    expectRejected(report);
    assert.deepEqual(report.verifiedCanceled, []);
  });
}

test('HTTP 404 fails even when the bytes of the error response are read successfully', () => {
  const input = transfer();
  input.failures = [];
  input.requests[0].terminal = 'finished';
  input.httpErrors.push({ requestId: input.requests[0].requestId, url, status: 404 });
  input.requests[0].status = input.served[0].status = input.reads[0].status = 404;
  const report = classifyTransport(input);
  assert.equal(report.strictTransportClean, false);
  expectRejected(report);
});

test('a same-length wrong body fails even if CDP completed without a failure', () => {
  assert.equal(incorrect.length, expected.length);
  const input = transfer();
  input.failures = [];
  input.requests[0].terminal = 'finished';
  input.reads[0].sha256 = digest(incorrect);
  const report = classifyTransport(input);
  assert.equal(report.strictTransportClean, true);
  expectRejected(report);
});

test('two canceled transfers for the identical URL can each prove their own receipt', () => {
  const first = transfer();
  const second = transfer('67.151', 'r0002');
  const input = { ...first };
  for (const key of ['failures', 'requests', 'served', 'reads']) {
    input[key] = [...first[key], ...second[key]];
  }
  input.reads.reverse();
  const result = classifyTransport(input);
  assert.equal(result.strictTransportClean, false);
  assert.equal(result.payloadIntegrityClean, true);
  assert.equal(result.verifiedCanceled.length, 2);
  assert.deepEqual(result.problems, []);

  // The valid first read must never stand in for the corrupted second body.
  input.reads[0].sha256 = digest(incorrect);
  const corrupted = classifyTransport(input);
  expectRejected(corrupted);
  assert.ok(corrupted.verifiedCanceled.length < 2);
});

test('two browser requests cannot share one response receipt for the identical URL', () => {
  const input = transfer();
  input.requests.push({ ...input.requests[0], requestId: '67.151' });
  input.failures.push({ ...input.failures[0], requestId: '67.151' });
  const report = classifyTransport(input);
  expectRejected(report);
  assert.ok(report.verifiedCanceled.length < 2);
});

function passiveScript() {
  const input = transfer();
  input.failures = [];
  input.reads = [];
  Object.assign(input.requests[0], {url:origin+'/src/main.js', type:'Script', terminal:'finished'});
  input.served[0].path = '/src/main.js';
  return input;
}

test('ordinary browser subresources pair with the HTTP server while blob URLs stay browser-local', () => {
  const input = passiveScript();
  input.requests.push({requestId:'blob-1', url:'blob:'+origin+'/generated', type:'Fetch', terminal:'finished'});
  const result = classifyTransport(input);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.coverage, {localHTTP:1, serverReceipts:1, paired:1, get200SourceAndWire:1, browserBlobs:1});
});

for (const [failure, mutate] of [
  ['HTTP receipt absent from CDP', x => { x.requests = []; }],
  ['CDP response absent from HTTP', x => { x.served = []; }],
  ['duplicate server receipt', x => { x.served.push({...x.served[0]}); }],
  ['two script requests bearing one receipt', x => { x.requests.push({...x.requests[0], requestId:'67.151'}); }],
  ['different methods', x => { x.requests[0].method = 'HEAD'; }],
  ['different query at the server', x => { x.served[0].path += '?alternate'; }],
  ['different statuses', x => { x.served[0].status = 204; }],
  ['missing CDP terminal', x => { x.requests[0].terminal = null; }],
  ['omitted CDP terminal field', x => { delete x.requests[0].terminal; }],
  ['server could not verify the original source', x => { x.served[0].sourceError = 'source changed or unreadable'; }],
  ['missing wire hash', x => { delete x.served[0].wireSHA256; }],
  ['wrong same-length script on the wire', x => { x.served[0].wireSHA256 = digest(incorrect); }],
  ['truncated body in a passive HTTP 200 response', x => { x.served[0].wireBytes--; }],
]) {
  test('a browser subresource without an application reader is rejected for '+failure, () => {
    const input = passiveScript();
    mutate(input);
    expectRejected(classifyTransport(input));
  });
}

test('the static host observes failed requests and supplies the resolved file only on success', async t => {
  const fixture = path.resolve(__dirname, '..');
  const visits = [];
  const files = [];
  const audit = {
    start(req, res) { visits.push(req.url); res.setHeader('x-test-receipt', String(visits.length)); },
    file(req, resolved, stat) { files.push([req.url, resolved, stat.size]); },
  };
  const bytes = fs.readFileSync(path.join(fixture, 'package.json'));
  for (const observer of [undefined, audit]) {
    const server = createStaticServer(fixture, observer);
    t.after(() => new Promise(resolve => server.close(resolve)));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseURL = 'http://127.0.0.1:' + server.address().port;
    const found = await fetch(baseURL + '/package.json');
    assert.equal(found.status, 200);
    assert.equal(found.headers.get('x-test-receipt'), observer ? '1' : null);
    assert.deepEqual(Buffer.from(await found.arrayBuffer()), bytes);
    const missing = await fetch(baseURL + '/no-such-transport-fixture.bin');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('x-test-receipt'), observer ? '2' : null);
    await missing.arrayBuffer();
  }
  assert.deepEqual(visits, ['/package.json', '/no-such-transport-fixture.bin']);
  assert.deepEqual(files, [['/package.json', fs.realpathSync(path.join(fixture,'package.json')),bytes.length]]);
});
