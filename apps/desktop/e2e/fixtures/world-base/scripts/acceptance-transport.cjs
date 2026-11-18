const fs = require('node:fs');
const crypto = require('node:crypto');

const RECEIPT = 'x-fixture-transfer';
const sourceAsset = /\.(?:glb|gltf|bin)$/i;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function index(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const id = row[key];
    if (!id) continue;
    if (!result.has(id)) result.set(id, []);
    result.get(id).push(row);
  }
  return result;
}

// The raw network gate remains available even if a complete read contradicts CDP's terminal event.
function classifyTransport({ origin, failures, httpErrors = [], requests, served, reads }) {
  const byId = index(requests, 'requestId');
  const byReceipt = index(requests, 'receipt');
  const serverRows = index(served, 'receipt');
  const appRows = index(reads, 'receipt');
  const failed = index(failures, 'requestId');
  const problems = [], verifiedCanceled = [];
  const coverage = {localHTTP:0, serverReceipts:served.length, paired:0, get200SourceAndWire:0, browserBlobs:0};
  const reject = (requestId, path, reason) => problems.push({requestId, path, reason});
  for (const error of httpErrors) reject(error.requestId, error.url, 'HTTP '+error.status);
  for (const error of failures) {
    if (!byId.has(error.requestId)) reject(error.requestId, error.url, 'failure without a matching CDP request');
  }
  for (const read of reads) {
    if (!byReceipt.has(read.receipt)) reject(null, read.path, 'application receipt without matching CDP response');
  }
  for (const response of served) {
    if (!response.receipt || serverRows.get(response.receipt)?.length !== 1 || byReceipt.get(response.receipt)?.length !== 1) {
      reject(null, response.path, 'server receipt has no unique CDP response');
    }
  }
  for (const request of requests) {
    const {requestId, receipt, url} = request;
    const errors = failed.get(requestId) || [];
    let parsed;
    try { parsed = new URL(url); } catch { reject(requestId, url, 'invalid CDP URL'); continue; }
    const local = ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol === 'blob:') coverage.browserBlobs++;
    if (!local) {
      if (receipt || errors.length) reject(requestId, url, 'outside this fixture origin');
      continue;
    }
    coverage.localHTTP++;
    const path = parsed.pathname + parsed.search;
    const server = serverRows.get(receipt) || [], app = appRows.get(receipt) || [];
    const needsRead = errors.length || app.length || (request.type === 'Fetch' && sourceAsset.test(parsed.pathname));
    let reason;
    if (byId.get(requestId)?.length !== 1 || !receipt || byReceipt.get(receipt)?.length !== 1 ||
        server.length !== 1) reason = 'missing or ambiguous HTTP/CDP receipt';
    else if (!request.method || !Number.isInteger(request.status) || request.status < 100 ||
             server[0].path !== path || server[0].method !== request.method || server[0].status !== request.status) {
      reason = 'HTTP/CDP method, status or path mismatch';
    } else {
      coverage.paired++;
    }
    if (reason) { reject(requestId, path, reason); continue; }
    const response = server[0];
    if (request.status >= 400) reason = 'HTTP '+request.status;
    else if (errors.length && (errors.length !== 1 || errors[0].url !== url || !errors[0].canceled ||
             errors[0].type !== 'Fetch' || errors[0].errorText !== 'net::ERR_ABORTED')) reason = 'unverified network failure';
    else if (request.terminal !== (errors.length ? 'failed' : 'finished')) reason = 'missing or inconsistent CDP terminal';
    else if (!response.finished || request.cached || request.redirected) reason = 'unfinished, cached or redirected response';
    else if (request.method === 'GET' && request.status === 200) {
      if (response.sourceError || !Number.isSafeInteger(response.fileBytes) || response.fileBytes < 0 ||
          response.declared !== response.fileBytes || response.wireBytes !== response.fileBytes) reason = 'body length differs from supplied file';
      else if (!/^[a-f0-9]{64}$/.test(response.sha256 || '') || response.wireSHA256 !== response.sha256) reason = 'response bytes differ from supplied file';
      else coverage.get200SourceAndWire++;
    }
    if (!reason && needsRead) {
      const read = app[0];
      if (app.length !== 1) reason = 'missing or ambiguous application receipt';
      else if (request.type !== 'Fetch' || request.method !== 'GET' || request.status !== 200 ||
               request.range || request.partial || response.range) reason = 'requires an uncached direct full HTTP 200 GET';
      else if (read.path !== path || read.status !== 200) reason = 'origin and application response mismatch';
      else if (!read.done || read.aborted || read.readError) reason = 'application did not finish its own body successfully';
      else if (read.declared !== response.fileBytes || read.received !== response.fileBytes) reason = 'body length differs from supplied file';
      else if (read.sha256 !== response.sha256) reason = 'body differs from supplied file';
    }
    if (reason) reject(requestId, path, reason);
    else if (errors.length) verifiedCanceled.push({requestId, receipt, path, bytes:app[0].received, sha256:app[0].sha256});
  }
  return {strictTransportClean:failures.length === 0 && httpErrors.length === 0, payloadIntegrityClean:problems.length === 0, coverage, verifiedCanceled, problems};
}

// Installed only for requested acceptance diagnostics. Observe bytes passed to the real consumer.
// Do not clone, tee, or fetch a second body to obtain a receipt.
function observeApplication(header) {
  const rows = [], pending = [], responses = new WeakMap(), streams = new WeakMap(), readers = new WeakMap();
  const nativeArrayBuffer = Response.prototype.arrayBuffer;
  function completed(state, bytes, method) {
    Object.assign(state.row, {method, done:true, received:bytes.byteLength});
    pending.push(crypto.subtle.digest('SHA-256', bytes).then(digest => {
      state.row.sha256 = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2,'0')).join('');
    }));
  }
  const fetchOriginal = window.fetch;
  window.fetch = async function (input, init) {
    const response = await fetchOriginal.apply(this, arguments);
    const receipt = response.headers.get(header);
    if (!receipt) return response;
    const url = new URL(response.url);
    const signal = init?.signal ?? input?.signal;
    const length = response.headers.get('content-length');
    const row = {receipt, path:url.pathname+url.search, status:response.status,
      declared:length === null ? null : Number(length), received:0, done:false, aborted:!!signal?.aborted, readError:null};
    rows.push(row);
    signal?.addEventListener('abort', () => { row.aborted = true; }, {once:true});
    const state = {row, chunks:[]};
    responses.set(response, state);
    if (response.body) streams.set(response.body, state);
    return response;
  };
  const get = ReadableStream.prototype.getReader, read = ReadableStreamDefaultReader.prototype.read;
  ReadableStream.prototype.getReader = function () {
    const actual = get.apply(this, arguments);
    if (streams.has(this)) readers.set(actual, streams.get(this));
    return actual;
  };
  ReadableStreamDefaultReader.prototype.read = function () {
    const work = read.apply(this, arguments), state = readers.get(this);
    if (!state) return work;
    return work.then(result => {
      if (result.done && !state.row.done) {
        const bytes = new Uint8Array(state.row.received);
        let offset = 0;
        for (const part of state.chunks) { bytes.set(part, offset); offset += part.byteLength; }
        state.chunks.length = 0;
        completed(state, bytes, 'reader EOF');
      } else if (result.value?.byteLength) {
        state.chunks.push(result.value.slice());
        state.row.received += result.value.byteLength;
      }
      return result;
    }, error => { state.row.readError=String(error); throw error; });
  };
  for (const [proto, lookup] of [[ReadableStreamDefaultReader.prototype, readers], [ReadableStream.prototype, streams]]) {
    const cancel = proto.cancel;
    proto.cancel = function () {
      const state = lookup.get(this);
      if (state) state.row.aborted = true;
      return cancel.apply(this, arguments);
    };
  }
  for (const method of ['arrayBuffer', 'blob', 'text', 'json']) {
    const original = Response.prototype[method];
    Response.prototype[method] = function () {
      const state = responses.get(this);
      if (!state) return original.apply(this, arguments);
      // text/json are UTF-8 Body mixin operations. Decode the same single native
      // arrayBuffer (TextDecoder strips BOM) and propagate read/parse errors.
      const result = method === 'text' || method === 'json'
        ? nativeArrayBuffer.call(this) : original.apply(this, arguments);
      return result.then(async data => {
        try {
          const bytes = method === 'blob' ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
          completed(state, bytes, method+'()');
          if (method === 'text' || method === 'json') {
            const text = new TextDecoder().decode(bytes);
            return method === 'text' ? text : JSON.parse(text);
          }
          return data;
        } catch (e) { state.row.readError=String(e); throw e; }
      }, error => { state.row.readError=String(error); throw error; });
    };
  }
  window.__fixtureTransferReads = async () => { await Promise.all(pending); return rows; };
}

function createTransportAudit() {
  const incoming = new WeakMap(), served = [], browser = new Map();
  const prefix = crypto.randomUUID();

  function start(req, res) {
    const receipt = prefix+'-'+(served.length+1);
    const row = {receipt, path:req.url, method:req.method, range:req.headers.range !== undefined,
      status:null, finished:false, wireBytes:0, wireSHA256:null};
    served.push(row);
    incoming.set(req, row);
    res.setHeader(RECEIPT, receipt);
    const checksum = crypto.createHash('sha256');
    function count(data, encoding) {
      if (typeof data === 'string') data = Buffer.from(data, typeof encoding==='string' ? encoding : 'utf8');
      if (ArrayBuffer.isView(data)) { row.wireBytes += data.byteLength; checksum.update(data); }
    }
    const write = res.write, end = res.end;
    res.write = function (data, encoding) { count(data, encoding); return write.apply(this, arguments); };
    res.end = function (data, encoding) { count(data, encoding); return end.apply(this, arguments); };
    res.on('finish', () => {
      const length = res.getHeader('content-length');
      row.declared = length !== undefined && /^\d+$/.test(String(length)) ? Number(length) : null;
      row.finished = true;
      row.status = res.statusCode;
      row.wireSHA256 = checksum.digest('hex');
    });
    res.on('close', () => { row.status=res.statusCode; });
  }

  function file(req, resolved, stat) {
    const row = incoming.get(req);
    row.localFile = resolved;
    row.stat = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.dev, stat.ino];
    row.fileBytes = stat.size;
  }

  function generated(req, data) {
    const row = incoming.get(req);
    const bytes = Buffer.from(data);
    row.fileBytes = bytes.length;
    row.sha256 = hash(bytes);
    row.sourceKind = 'generated by fixture server';
  }

  function header(headers, name) {
    return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
  }

  function cdp(method, params) {
    const id = params.requestId;
    if (!id || !method.startsWith('Network.')) return;
    if (!browser.has(id)) browser.set(id, {requestId:id, receipt:null, status:null, range:false, partial:false,
      cached:false, redirected:false, priorityChanges:[], terminal:null});
    const row = browser.get(id);
    if (method === 'Network.requestWillBeSent') {
      row.redirected ||= !!params.redirectResponse || !!row.url;
      row.url=params.request.url; row.method=params.request.method; row.type=params.type;
      row.priority=params.request.initialPriority; row.initiator=params.initiator?.type;
      row.range ||= header(params.request.headers,'range') !== undefined;
    } else if (method === 'Network.requestWillBeSentExtraInfo') {
      row.range ||= header(params.headers,'range') !== undefined;
    } else if (method === 'Network.resourceChangedPriority') {
      row.priorityChanges.push(params.newPriority);
    } else if (method === 'Network.requestServedFromCache') {
      row.cached=true;
    } else if (method === 'Network.responseReceived' || method === 'Network.responseReceivedExtraInfo') {
      const response = params.response;
      const headers = response?.headers || params.headers;
      const token = header(headers, RECEIPT);
      if (token && row.receipt && row.receipt !== token) row.redirected=true;
      if (token) row.receipt=token;
      row.status = response?.status ?? params.statusCode ?? row.status;
      row.partial ||= header(headers, 'content-range') !== undefined || row.status === 206;
      row.cached ||= !!(response?.fromDiskCache || response?.fromServiceWorker || response?.fromPrefetchCache);
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      row.terminal=row.terminal ? 'duplicate' : method==='Network.loadingFailed' ? 'failed' : 'finished';
    }
  }

  async function finish({origin, failures, httpErrors=[], readPage}) {
    let reads=[], auditError=null;
    try { reads=await readPage('window.__fixtureTransferReads()'); if (!Array.isArray(reads)) throw Error('Missing application ledger'); }
    catch (e) { auditError=String(e); reads=[]; }
    const digests = new Map();
    const servers = served.map(({localFile,stat,...row}) => {
      if (!localFile) return row;
      try {
        const current=fs.statSync(localFile);
        const identity=[current.size,current.mtimeMs,current.ctimeMs,current.dev,current.ino];
        if (!identity.every((n,i)=>n===stat[i])) throw Error('provided file changed during capture');
        if (!digests.has(localFile)) digests.set(localFile,hash(fs.readFileSync(localFile)));
        return {...row,sha256:digests.get(localFile)};
      } catch (e) { return {...row,sourceError:e.code || 'source changed or unreadable'}; }
    });
    const requests = [...browser.values()].filter(r => r.url);
    const report = classifyTransport({origin, failures, httpErrors, requests, served:servers, reads});
    if (auditError || !servers.length || !requests.length || !reads.length) {
      report.problems.push({reason:auditError || 'missing fixture server, CDP or application records'});
      report.payloadIntegrityClean=false;
    }
    return {...report, requests, served:servers, reads};
  }

  return {start, file, generated, cdp, finish, pageSource:'('+observeApplication.toString()+')('+JSON.stringify(RECEIPT)+')'};
}

module.exports = {createTransportAudit, classifyTransport};
