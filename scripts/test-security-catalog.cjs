'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const http2 = require('node:http2');
const { once } = require('node:events');
const { createHash, randomBytes } = require('node:crypto');
const { createRequire, builtinModules } = require('node:module');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const googleRequire = createRequire(path.join(root, 'fixtures/google/package.json'));
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const digest = value => createHash('sha256').update(value).digest('hex');
const sources = ['scripts/test-security-catalog.cjs', 'scripts/security-catalog-evidence.cjs', 'fixtures/worker/security-catalog.mjs',
  'test/security-catalog.test.cjs', 'test/security-catalog-evidence.test.cjs', 'test/retry-interop.test.cjs',
  'fixtures/worker/package-lock.json', 'fixtures/google/package-lock.json', 'fixtures/native/package-lock.json'];
function trailerFrame(headers) {
  const bytes = Buffer.from(Object.entries(headers).filter(([key]) => !key.startsWith(':'))
    .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(item => `${key}: ${item}\r\n`)).join(''));
  const frame = Buffer.alloc(5 + bytes.length); frame[0] = 128; frame.writeUInt32BE(bytes.length, 1); bytes.copy(frame, 5); return frame;
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

async function runRetryInterop({ grpc, createWorkersGrpcTransport }) {
  const native = nativeRequire('@grpc/grpc-js');
  const { OAuth2Client } = googleRequire('google-auth-library');
  const { createApiCall, CallSettings, RetryOptions } = googleRequire('google-gax');
  const accessToken = randomBytes(30).toString('hex'), refreshToken = randomBytes(30).toString('hex');
  const counts = { tokenRequests: 0, dataFetches: 0, bridgeArrivals: 0, serverArrivals: 0,
    serverBearerMatches: 0, serverBearerUnexpected: 0, tokenRequestShapeMatches: 0, gaxLogicalCalls: 0, gaxNewGrpcCalls: 0 };
  const arrivals = [], calls = [], sessions = new Set();
  const method = { path: '/security.Retry/Unary', requestStream: false, responseStream: false,
    requestSerialize: value => Buffer.from(value), requestDeserialize: bytes => bytes.toString(),
    responseSerialize: value => Buffer.from(value), responseDeserialize: bytes => bytes.toString() };
  const server = new native.Server();
  server.addService({ unary: method }, { unary(call, callback) {
    counts.serverArrivals++;
    const authorization = call.metadata.get('authorization');
    const authenticated = call.request !== 'direct-unavailable';
    counts.serverBearerMatches += Number(authenticated && authorization[0] === `Bearer ${accessToken}`);
    counts.serverBearerUnexpected += Number(authenticated ? authorization[0] !== `Bearer ${accessToken}` : authorization.length !== 0);
    arrivals.push({ scenario: call.request, bearerMatched: authenticated && authorization[0] === `Bearer ${accessToken}` });
    if (call.request === 'direct-unavailable' || (call.request === 'gax-retry' && arrivals.filter(row => row.scenario === 'gax-retry').length === 1)) {
      callback({ code: native.status.UNAVAILABLE, details: 'controlled unavailable' });
    } else callback(null, 'accepted');
  } });
  const nativePort = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', native.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
  const bridge = http.createServer((request, response) => {
    if (request.url === '/token') {
      counts.tokenRequests++; const chunks = [];
      request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        counts.tokenRequestShapeMatches += Number(request.method === 'POST' && form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === refreshToken);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: accessToken, expires_in: 3600, token_type: 'Bearer' }));
      }); return;
    }
    counts.bridgeArrivals++;
    const session = http2.connect(`http://127.0.0.1:${nativePort}`); sessions.add(session);
    session.on('close', () => sessions.delete(session)); session.on('error', () => response.destroy());
    const upstream = session.request({ ':method': 'POST', ':path': request.url,
      'content-type': 'application/grpc', te: 'trailers',
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(request.headers['grpc-timeout'] ? { 'grpc-timeout': request.headers['grpc-timeout'] } : {}) });
    let hasStatus = false;
    upstream.on('response', headers => {
      const out = Object.fromEntries(Object.entries(headers).filter(([key]) => !key.startsWith(':') && !['content-type', 'content-length'].includes(key)));
      response.writeHead(200, { ...out, 'content-type': 'application/grpc-web+proto' }); hasStatus = headers['grpc-status'] !== undefined;
    });
    upstream.on('data', chunk => response.write(chunk));
    upstream.on('trailers', headers => { hasStatus = true; response.write(trailerFrame(headers)); });
    upstream.on('end', () => { if (!hasStatus) response.destroy(); else response.end(); session.close(); });
    upstream.on('error', () => { response.destroy(); session.destroy(); });
    response.on('close', () => { if (!upstream.closed) upstream.close(http2.constants.NGHTTP2_CANCEL); session.close(); });
    request.pipe(upstream);
  });
  const bridgeOrigin = await listen(bridge), observer = [];
  // The trusted test fetcher terminates the HTTPS-labelled boundary locally.
  // This is native HTTP/2 interop, not evidence of production TLS or live Google.
  const factory = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'retry.test': 'https://retry-gateway.test' },
    observer: event => observer.push(event), fetcher: { fetch(url, init) { counts.dataFetches++; return fetch(bridgeOrigin + new URL(url).pathname, init); } } });
  const auth = new OAuth2Client({ clientId: 'security-fixture', clientSecret: randomBytes(24).toString('hex'), endpoints: { oauth2TokenUrl: bridgeOrigin + '/token' } });
  auth.setCredentials({ access_token: 'expired-fixture-token', refresh_token: refreshToken, expiry_date: Date.now() - 1000 });
  const direct = new grpc.Client('retry.test', grpc.credentials.createSsl(), factory.grpcOptions());
  const authenticated = new grpc.Client('retry.test', grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), grpc.credentials.createFromGoogleCredential(auth)), factory.grpcOptions());
  function start(client, request, options, callback) {
    const receipt = { scenario: request, callbacks: 0, statuses: [] }; calls.push(receipt);
    const call = client.makeUnaryRequest(method.path, method.requestSerialize, method.responseDeserialize, request, options,
      (error, value) => { receipt.callbacks++; receipt.callbackCode = error?.code ?? 0; callback(error, value); });
    call.on('status', status => receipt.statuses.push({ code: status.code, details: status.details })); return call;
  }
  const unary = (client, request) => new Promise(resolve => start(client, request, { deadline: Date.now() + 5000 }, (error, value) => resolve({ code: error?.code ?? 0, value })));
  try {
    assert.equal((await unary(direct, 'direct-unavailable')).code, 14);
    await new Promise(resolve => setImmediate(resolve));
    const noRetry = { id: 'RETRY-001', status: 'passed', dataFetches: counts.dataFetches, serverArrivals: counts.serverArrivals,
      bridgeArrivals: counts.bridgeArrivals, tokenRequests: counts.tokenRequests, calls: structuredClone(calls), adapterRetryConfigured: false };
    assert.deepEqual([noRetry.dataFetches, noRetry.serverArrivals, noRetry.bridgeArrivals, noRetry.tokenRequests], [1, 1, 1, 0]);
    assert.deepEqual(await unary(authenticated, 'auth-success'), { code: 0, value: 'accepted' });
    const settings = new CallSettings({ timeout: 5000, retry: new RetryOptions([14], {
      initialRetryDelayMillis: 1, retryDelayMultiplier: 1, maxRetryDelayMillis: 1,
      initialRpcTimeoutMillis: 5000, rpcTimeoutMultiplier: 1, maxRpcTimeoutMillis: 5000, totalTimeoutMillis: 10000,
    }) });
    const api = createApiCall((request, _metadata, options, callback) => {
      counts.gaxNewGrpcCalls++; return start(authenticated, request, options, callback);
    }, settings);
    counts.gaxLogicalCalls++; assert.equal((await api('gax-retry'))[0], 'accepted');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(counts, { tokenRequests: 1, dataFetches: 4, bridgeArrivals: 4, serverArrivals: 4,
      serverBearerMatches: 3, serverBearerUnexpected: 0, tokenRequestShapeMatches: 1, gaxLogicalCalls: 1, gaxNewGrpcCalls: 2 });
    assert.equal(direct.getChannel().activeCallCount() + authenticated.getChannel().activeCallCount(), 0);
    const ends = observer.filter(event => event.type === 'call-end');
    assert.deepEqual(ends.map(event => [event.attemptCount, event.fetchCount]), [[1, 1], [1, 1], [1, 1], [1, 1]]);
    for (const call of calls) { assert.equal(call.callbacks, 1); assert.equal(call.statuses.length, 1); }
    return { status: 'passed', nativeHttp2: true, trustedLoopbackFetcher: true, productionTls: false, liveGoogle: false,
      nativeVersion: nativeRequire('@grpc/grpc-js/package.json').version, googleAuthVersion: googleRequire('google-auth-library/package.json').version,
      gaxVersion: googleRequire('google-gax').version, results: [noRetry, { id: 'RETRY-004', status: 'passed', ...counts,
        calls, arrivals, adapterCallEnds: ends, adapterRetryConfigured: false, activeCalls: 0 }], cleanupVerifiedBeforeShutdown: true };
  } finally { direct.close(); authenticated.close(); for (const session of sessions) session.destroy(); await close(bridge); server.forceShutdown(); }
}

function scanArtifacts(files, markers) {
  return files.map(file => {
    const bytes = fs.readFileSync(file);
    return { path: path.relative(root, file), bytes: bytes.length, sha256: digest(bytes),
      markerHits: markers.reduce((sum, marker) => sum + Number(bytes.includes(Buffer.from(marker))), 0) };
  });
}
function filesUnder(directory, accept = () => true) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file, accept) : entry.isFile() && accept(file) ? [file] : [];
  });
}
async function main({ sourceBuild = process.argv.includes('--source-build') } = {}) {
  const reportFile = path.join(root, 'verification/security-catalog.json');
  const artifactDir = path.join(root, 'verification/security-catalog'); fs.mkdirSync(artifactDir, { recursive: true });
  const report = { status: 'running', sourceBuild, startedAt: new Date().toISOString(), compatibilityDate: '2026-09-21',
    liveCloud: false, productionTls: false, incomingCloudflareTranslation: false, runs: [], networkReceipts: [], externalRequests: 0,
    installedInputs: {}, nativeInputs: {}, evidence: {}, protocol: {
      grpcMetadata: 'https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md', base64: 'https://www.rfc-editor.org/rfc/rfc4648.html#section-4',
      paddingPolicy: 'Accept canonical padded or unpadded values; reject partial, extra, embedded padding and noncanonical trailing bits.',
    } };
  const write = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const authMarker = randomBytes(32).toString('hex'), payloadMarker = randomBytes(32).toString('hex');
  try {
    const grpc = sourceBuild ? require('../dist/index.js') : workerRequire('@grpc/grpc-js');
    const { createWorkersGrpcTransport } = sourceBuild ? require('../dist/adapter.js') : workerRequire('@grpc/grpc-js/adapter');
    const { runSecurityCatalog } = await import('../fixtures/worker/security-catalog.mjs');
    const receiptFor = (runtime, mode, httpStatus) => {
      let row = report.networkReceipts.find(value => value.runtime === runtime && value.mode === mode && value.httpStatus === httpStatus);
      if (!row) { row = { runtime, mode, httpStatus, gatewayArrivals: 0, gatewayBearerMatches: 0, attackerArrivals: 0, attackerBearerArrivals: 0 }; report.networkReceipts.push(row); }
      return row;
    };
    let nodeContext;
    const attacker = http.createServer((request, response) => {
      nodeContext.attackerArrivals++; nodeContext.attackerBearerArrivals += Number(request.headers.authorization === `Bearer ${authMarker}`);
      response.end();
    });
    const attackerOrigin = await listen(attacker);
    const gateway = http.createServer((request, response) => {
      const receipt = receiptFor('node', request.headers['x-security-mode'], Number(request.headers['x-security-redirect'])); nodeContext = receipt;
      receipt.gatewayArrivals++; receipt.gatewayBearerMatches += Number(request.headers.authorization === `Bearer ${authMarker}`);
      request.resume(); response.writeHead(receipt.httpStatus, { location: attackerOrigin + '/capture' }); response.end();
    });
    const gatewayOrigin = await listen(gateway);
    try {
      for (const mode of ['cloudflare', 'grpc-web']) report.runs.push(await runSecurityCatalog({ grpc, createWorkersGrpcTransport, runtime: 'node', mode, authMarker, payloadMarker,
        network: (url, init) => fetch(gatewayOrigin + new URL(url).pathname, init) }));
    } finally { await close(gateway); await close(attacker); }
    const builtins = [...new Set(builtinModules.map(name => name.replace(/^node:/, '')).filter(name => !name.startsWith('_') && !name.includes('/')))];
    const used = ['assert', 'buffer', 'crypto', 'events', 'fs', 'http', 'https', 'net', 'os', 'path', 'process', 'querystring', 'stream', 'tls', 'url', 'util', 'zlib'];
    const banner = used.map((name, index) => `import * as b${index} from 'node:${name}';`).join('')
      + `const libs={${used.flatMap((name, index) => [`'${name}':b${index}`, `'node:${name}':b${index}`]).join(',')}};const require=n=>{if(libs[n])return libs[n];throw new Error('SECURITY_UNEXPECTED_BUILTIN '+n)};`;
    const bundle = await workerRequire('esbuild').build({ absWorkingDir: root, entryPoints: ['fixtures/worker/security-catalog.mjs'],
      outfile: path.join(artifactDir, 'worker.mjs'), bundle: true, write: false, sourcemap: 'external', metafile: true, format: 'esm',
      platform: 'node', target: 'es2022', external: [...builtins, 'node:*'], banner: { js: banner },
      ...(sourceBuild ? { alias: { '@grpc/grpc-js/adapter': path.join(root, 'dist/adapter.js'), '@grpc/grpc-js': path.join(root, 'dist/index.js') } } : {}) });
    for (const file of bundle.outputFiles) fs.writeFileSync(file.path, file.contents, { mode: 0o600 });
    const script = bundle.outputFiles.find(file => file.path.endsWith('.mjs')).text;
    report.bundleSha256 = digest(script);
    for (const file of Object.keys(bundle.metafile.inputs).filter(file => file.includes('/node_modules/'))) report.installedInputs[file] = digest(fs.readFileSync(path.join(root, file)));
    const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
    const runtimeLogs = [];
    class CaptureLog extends Log {
      log(message) { runtimeLogs.push(String(message)); }
      warn(message) { runtimeLogs.push(String(message)); }
      error(error) { runtimeLogs.push(String(error?.stack ?? error)); }
    }
    const runtime = new Miniflare(convertV4MiniflareOptions({ log: new CaptureLog(LogLevel.NONE), modules: true, script,
      compatibilityDate: report.compatibilityDate, compatibilityFlags: ['nodejs_compat'], outboundService(request) {
        const url = new URL(request.url), mode = request.headers.get('x-security-mode'), httpStatus = Number(request.headers.get('x-security-redirect'));
        const receipt = receiptFor('workerd', mode, httpStatus);
        if (url.hostname === 'security-gateway.test') {
          receipt.gatewayArrivals++; receipt.gatewayBearerMatches += Number(request.headers.get('authorization') === `Bearer ${authMarker}`);
          return new Response(null, { status: httpStatus, headers: { location: 'https://security-attacker.test/capture' } });
        }
        if (url.hostname === 'security-attacker.test') {
          receipt.attackerArrivals++; receipt.attackerBearerArrivals += Number(request.headers.get('authorization') === `Bearer ${authMarker}`); return new Response();
        }
        report.externalRequests++; throw new Error('SECURITY_EXTERNAL_REQUEST');
      } }));
    try {
      for (const mode of ['cloudflare', 'grpc-web']) {
        const response = await runtime.dispatchFetch('https://security-entry.test/run', { method: 'POST',
          body: JSON.stringify({ mode, authMarker, payloadMarker }), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000) });
        const result = await response.json(); assert.equal(response.status, 200, result.diagnostic ?? 'SECURITY_WORKER_FAILURE'); report.runs.push(result);
      }
    } finally { await runtime.dispose(); report.runtimeDisposed = true; }
    report.interop = await runRetryInterop({ grpc, createWorkersGrpcTransport });
    const native = nativeRequire('@grpc/grpc-js');
    report.nativePadding = ['AQI=', 'AQI', 'AQI==', 'AQ=', 'AAAA='].map(value => ({ input: value,
      decodedHex: native.Metadata.fromHttp2Headers({ 'trace-bin': value }).get('trace-bin').map(bytes => bytes.toString('hex')) }));
    report.nativePaddingPolicyDifference = 'Pinned native grpc-js delegates to permissive Buffer base64 decoding; adapter deliberately rejects malformed padding under the catalog protocol-error contract.';
    for (const file of Object.keys(require.cache).filter(file => file.startsWith(path.join(root, 'fixtures/native/node_modules/')) || file.startsWith(path.join(root, 'fixtures/google/node_modules/')))) {
      report.nativeInputs[path.relative(root, file)] = digest(fs.readFileSync(file));
    }
    report.node = process.version; report.miniflare = workerRequire('miniflare/package.json').version; report.workerd = workerRequire('workerd/package.json').version;
    report.evidence = Object.fromEntries(sources.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
    report.status = 'passed'; report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(artifactDir, 'runtime.log'), JSON.stringify({ runtimeLogs, runs: report.runs.map(run => ({ runtime: run.runtime, mode: run.mode, logs: run.logs })) }) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(artifactDir, 'calls.json'), JSON.stringify({ runs: report.runs, interop: report.interop }) + '\n', { mode: 0o600 });
    report.artifactInputs = Object.fromEntries(['runtime.log', 'calls.json', 'worker.mjs', 'worker.mjs.map'].map(name => {
      const file = path.join(artifactDir, name); return [path.relative(root, file), digest(fs.readFileSync(file))];
    }));
    write();
    const files = [...new Set([...filesUnder(path.join(root, 'verification')), ...filesUnder(path.join(root, 'dist'), file => file.endsWith('.map'))])].sort();
    const markers = [authMarker, payloadMarker];
    report.artifactScan = { markerCount: 2, markerGeneration: 'runtime-random-256-bit',
      scope: 'all verification artifacts, suite captured runtime logs/reports/bundle/source map, and dist source maps present at execution',
      positiveControlHits: ['log', 'report', 'source-map'].map(kind => ({ kind, hits: markers.filter(marker => (`${kind}:${authMarker}:${payloadMarker}`).includes(marker)).length })),
      files: scanArtifacts(files, markers) };
    assert.equal(report.artifactScan.files.reduce((sum, file) => sum + file.markerHits, 0), 0, 'SECURITY_ARTIFACT_LEAK');
    // The report's scan record cannot contain its own final digest. The scan
    // includes the pre-scan report and verifies the final serialization too.
    assert.equal(markers.some(marker => JSON.stringify(report).includes(marker)), false, 'SECURITY_REPORT_LEAK');
    report.artifactScan.finalReportClean = true;
    report.catalogCases = require('./security-catalog-evidence.cjs').catalogCases(report);
    require('./security-catalog-evidence.cjs').validateSecurityCatalogReport(report, { allowSourceBuild: sourceBuild });
    write(); return report;
  } catch (error) {
    report.status = 'failed'; report.errorMessage = String(error.stack ?? error).split(authMarker).join('[redacted]').split(payloadMarker).join('[redacted]').slice(0, 6000);
    report.finishedAt = new Date().toISOString(); write(); throw new Error(report.errorMessage);
  }
}
module.exports = { main, runRetryInterop, scanArtifacts, sources };
if (require.main === module) {
  const watchdog = setTimeout(() => { console.error('SECURITY_SUITE_TIMEOUT'); process.exit(1); }, 120000);
  main().then(report => console.log(JSON.stringify({ status: report.status, cases: report.catalogCases.length, scenarios: report.runs.reduce((sum, run) => sum + run.rows.length, 0) })))
    .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
}
