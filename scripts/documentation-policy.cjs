'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { isDeepStrictEqual } = require('node:util');
const root = path.resolve(__dirname, '..');
const sources = ['scripts/documentation-policy.cjs', 'compatibility/documentation-policy.json', 'compatibility/export-policy.json',
  'fixtures/worker/package.json', 'fixtures/worker/package-lock.json'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function need(value, message) { if (!value) throw new Error(`WGA_DOCUMENTATION_POLICY: ${message}`); }
function equal(actual, expected, message) { need(isDeepStrictEqual(actual, expected), message); }
function read(base, file) {
  need(typeof file === 'string' && !path.isAbsolute(file) && !file.includes('\\') && file.split('/').every(part => part && part !== '.' && part !== '..'), 'unsafe source path');
  let target = base;
  for (const part of file.split('/')) { target = path.join(target, part); need(!fs.lstatSync(target).isSymbolicLink(), 'symlink source path'); }
  need(fs.statSync(target).isFile(), 'regular source file');
  return fs.readFileSync(path.join(base, file));
}
function installedInputs(base) {
  const prefix = 'fixtures/worker/node_modules/@grpc/grpc-js/';
  function walk(directory) {
    need(!fs.lstatSync(path.join(base, directory)).isSymbolicLink(), 'symlink installed directory');
    return fs.readdirSync(path.join(base, directory), { withFileTypes: true }).flatMap(entry => {
      need(!entry.isSymbolicLink(), 'symlink installed implementation');
      const file = `${directory}/${entry.name}`;
      return entry.isDirectory() ? walk(file) : [file];
    });
  }
  return Object.fromEntries([...walk(prefix + 'dist'), prefix + 'package.json'].sort().map(file => [file, hash(read(base, file))]));
}
function checkClaims(manifest, policy, contract, text, tap) {
  need(manifest.schemaVersion === 1 && Array.isArray(manifest.claims) && manifest.claims.length === 6, 'complete boundary manifest');
  equal(manifest.claims.map(row => row.id), ['unsupported-root', 'native-readiness', 'tls-options', 'auth-failure', 'logical-peer', 'message-caps'], 'exact boundary subjects');
  need(contract.status === 'passed' && contract.fullNativeExportParity === false
    && contract.policySha256 === hash(text('compatibility/export-policy.json')), 'executed export policy identity');
  equal(contract.classifications.map(row => ({ name: row.name, grade: row.grade, scope: row.scope, signatureNotes: row.signatureNotes })),
    policy.entries, 'complete export classification and scope');
  need(contract.classifications.every(row => row.status === 'passed'), 'all export classifications executed');
  const exportsDoc = text('docs/exports.md');
  const absent = exportsDoc.split('## Type-only and absent names\n')[1]?.split('## Explicit package subpaths\n')[0];
  const rows = (absent || '').split('\n').filter(line => /^\| Native |^\| Legacy /.test(line));
  const names = rows.flatMap(line => [...line.matchAll(/`([^`]+)`/g)].map(match => match[1])).sort();
  equal(names, policy.entries.filter(row => row.grade === 'U').map(row => row.name).sort(), 'documented absent exports are exhaustive');
  for (const grade of ['S', 'I', 'T', 'U']) {
    const row = exportsDoc.split('\n').find(line => line.startsWith(`| ${grade} |`));
    need(row && Number(row.split('|').at(-2).trim()) === policy.entries.filter(item => item.grade === grade).length, `documented ${grade} count`);
  }
  return manifest.claims.map(claim => {
    need(Array.isArray(claim.documents) && claim.documents.length && Array.isArray(claim.tests) && claim.tests.length, 'claim proof requirements');
    const documents = claim.documents.map(document => {
      need(document.excerpts?.length && document.excerpts.every(excerpt => typeof excerpt === 'string' && excerpt.length > 20), 'substantive excerpts');
      const source = text(document.path);
      for (const excerpt of document.excerpts) need(source.includes(excerpt), `${claim.id}: documentation drift in ${document.path}`);
      return { path: document.path, sha256: hash(source), excerpts: document.excerpts.length };
    });
    const tests = claim.tests.map(test => {
      const { namedTests } = require('./test-evidence.cjs');
      need(namedTests(text(test.source), test.source).includes(test.name), `${claim.id}: named proof test missing`);
      need(tap.get(test.name) === 'passed', `${claim.id}: proof test not passed`);
      return { ...test, status: 'passed' };
    });
    return { id: claim.id, status: 'passed', documents, tests };
  });
}
async function observeInstalled(base, policy) {
  const req = createRequire(path.join(base, 'fixtures/worker/package.json'));
  const grpc = req('@grpc/grpc-js'), { createWorkersGrpcTransport } = req('@grpc/grpc-js/adapter');
  const config = req('@grpc/grpc-js/config').getWorkersGrpcConfig();
  const absent = policy.entries.filter(row => row.grade === 'U').map(row => row.name);
  for (const name of absent) assert.equal(Object.hasOwn(grpc, name), false);
  const failures = [];
  for (const [name, invoke] of [['Server', () => new grpc.Server()], ['ServerCredentials.createSsl', () => grpc.ServerCredentials.createSsl()],
    ['ServerCredentials.createInsecure', () => grpc.ServerCredentials.createInsecure()]]) {
    assert.throws(invoke, error => { failures.push({ name, code: error.code }); return error.code === 'WGA_SERVER_UNSUPPORTED'; });
  }
  const tls = [];
  for (const args of [[Buffer.from('synthetic-ca')], [null, Buffer.from('synthetic-key')], [null, null, Buffer.from('synthetic-cert')], [null, null, null, {}]]) {
    assert.throws(() => grpc.credentials.createSsl(...args), error => { tls.push(error.code); return error.code === 'WGA_UNSUPPORTED_TLS'; });
  }
  const Constructor = grpc.makeGenericClientConstructor({ unary: { path: '/docs.Policy/Unary', requestStream: false, responseStream: false,
    requestSerialize: value => value, responseDeserialize: value => value } }, 'docs.Policy');
  const observations = [];
  for (const mode of ['cloudflare', 'grpc-web']) {
    let fetches = 0, receiveBytes = 1;
    const transport = createWorkersGrpcTransport({ mode, ...(mode === 'grpc-web' ? { endpoints: { 'docs-policy.test': 'https://docs-gateway.test' } } : {}),
      transportMaxSendBytes: 16, transportMaxReceiveBytes: 16, defaultTimeoutMs: 5000, fetcher: { async fetch() {
        fetches++;
        const data = Buffer.alloc(5 + receiveBytes); data.writeUInt32BE(receiveBytes, 1);
        const trailer = Buffer.from('grpc-status: 0\r\n'), end = Buffer.alloc(5); end[0] = 128; end.writeUInt32BE(trailer.length, 1);
        return new Response(Buffer.concat([data, end, trailer]), { headers: { 'content-type': 'application/grpc-web+proto' } });
      } } });
    const client = new Constructor('docs-policy.test', transport.channelCredentials,
      transport.grpcOptions({ 'grpc.max_send_message_length': -1, 'grpc.max_receive_message_length': -1 }));
    try {
    const readiness = [];
    for (const invoke of [callback => client.waitForReady(Date.now() + 1000, callback),
      callback => grpc.waitForClientReady(client, Date.now() + 1000, callback)]) {
      let synchronous = true;
      const pending = new Promise((resolve, reject) => invoke(error => { try {
        assert.equal(synchronous, false); assert.equal(error.code, 12); assert.match(error.message, /WGA_CONNECTIVITY_UNSUPPORTED/);
        readiness.push({ code: error.code, asynchronous: !synchronous }); resolve();
      } catch (failure) { reject(failure); } }));
      synchronous = false; await pending;
    }
    assert.equal(fetches, 0);
    const auth = [];
    for (const code of ['absent', 'string', 'null', 'object', ...Array.from({ length: 17 }, (_, i) => i), 99]) {
      const credentials = grpc.credentials.createFromMetadataGenerator((_options, callback) => {
        const error = new Error('synthetic private auth detail');
        if (code !== 'absent') error.code = code === 'string' ? '16' : code === 'null' ? null : code === 'object' ? { code: 16 } : code;
        callback(error);
      });
      let surface;
      const received = await new Promise(resolve => {
        surface = client.unary(Buffer.alloc(1), { credentials }, (error, value) => resolve({ error, value }));
      });
      const expected = typeof code === 'string' ? 2 : [0, 3, 5, 6, 9, 10, 11, 15, 99].includes(code) ? 13 : code;
      assert.equal(received.error.code, expected); assert.equal(received.error.details, 'WGA_AUTH_METADATA');
      assert.equal(received.error.message.includes('synthetic private auth detail'), false); assert.equal(received.value, undefined);
      let call = surface.call;
      while (call && typeof call.getAuthContext !== 'function') call = call.call ?? call.nextCall;
      assert.ok(call); assert.equal(call.getAuthContext(), null); assert.equal(surface.getPeer(), 'https://docs-policy.test:443');
      auth.push({ inputCode: code, code: received.error.code, details: received.error.details,
        privateDetailsLeaked: false, peer: surface.getPeer(), authContext: call.getAuthContext() });
    }
    assert.equal(fetches, 0);
    const invoke = bytes => new Promise(resolve => client.unary(Buffer.alloc(bytes), (error, value) =>
      resolve({ code: error?.code ?? 0, bytes: value?.length ?? null })));
    const sendRejected = await invoke(17); assert.deepEqual(sendRejected, { code: 8, bytes: null }); assert.equal(fetches, 0);
    receiveBytes = 17; const receiveRejected = await invoke(1); assert.deepEqual(receiveRejected, { code: 8, bytes: null }); assert.equal(fetches, 1);
    receiveBytes = 1; const recovered = await invoke(1); assert.deepEqual(recovered, { code: 0, bytes: 1 }); assert.equal(fetches, 2);
    await new Promise(resolve => setImmediate(resolve));
    const usage = transport.resourceUsage(); assert.equal(client.getChannel().activeCallCount(), 0);
    for (const key of ['activeCalls', 'queuedCalls', 'bufferedBytes']) assert.equal(usage[key], 0);
    observations.push({ mode, readiness, auth, sendRejected, receiveRejected, recovered, fetches,
      resourcesCheckedBeforeClose: true, activeCalls: usage.activeCalls, queuedCalls: usage.queuedCalls, bufferedBytes: usage.bufferedBytes });
    } finally { client.close(); }
  }
  return { absent, failures, tls, defaultCaps: { send: config.transportMaxSendBytes, receive: config.transportMaxReceiveBytes }, observations };
}
function validateDocumentationPolicyReport(report) {
  need(report?.schemaVersion === 1 && report.status === 'passed' && report.sourceBuild === false && report.runtimeExecuted === true
    && report.liveCloud === false && report.metadataRecorded === false && report.runtime === 'installed-node', 'execution scope');
  equal(report.claims.map(row => row.id), ['unsupported-root', 'native-readiness', 'tls-options', 'auth-failure', 'logical-peer', 'message-caps'], 'claim coverage');
  need(report.claims.every(row => row.status === 'passed' && row.documents.length && row.tests.length
    && row.tests.every(test => test.status === 'passed') && row.documents.every(document => validHash(document.sha256))), 'claim receipts');
  need(sources.every(file => validHash(report.evidence?.[file])) && validHash(report.resultInputs?.['verification/tests.tap'])
    && validHash(report.resultInputs?.['compatibility/exports-contract.json']), 'source/result provenance');
  need(Object.keys(report.installedInputs || {}).length > 2 && Object.entries(report.installedInputs).every(([file, hash]) =>
    file.startsWith('fixtures/worker/node_modules/@grpc/grpc-js/') && !file.split(/[\\/]/).includes('..') && validHash(hash)), 'installed input provenance');
  for (const file of ['dist/index.js', 'dist/adapter.js', 'dist/call.js', 'dist/credentials.js', 'dist/options.js', 'dist/config.js', 'package.json'])
    need(validHash(report.installedInputs[`fixtures/worker/node_modules/@grpc/grpc-js/${file}`]), 'required installed implementation');
  const observed = report.observed;
  need(Array.isArray(observed?.absent) && observed.absent.length === 40 && new Set(observed.absent).size === 40, 'absent native exports');
  equal(observed.failures, ['Server', 'ServerCredentials.createSsl', 'ServerCredentials.createInsecure'].map(name => ({ name, code: 'WGA_SERVER_UNSUPPORTED' })), 'server failures');
  equal(observed.tls, Array(4).fill('WGA_UNSUPPORTED_TLS'), 'all inline TLS inputs');
  equal(observed.defaultCaps, { send: 33554432, receive: 33554432 }, 'documented default ceilings');
  equal(observed.observations.map(row => row.mode), ['cloudflare', 'grpc-web'], 'both modes');
  for (const row of observed.observations) {
    equal(row.readiness, Array.from({ length: 2 }, () => ({ code: 12, asynchronous: true })), 'asynchronous readiness failure');
    equal(row.auth, ['absent', 'string', 'null', 'object', ...Array.from({ length: 17 }, (_, i) => i), 99].map(inputCode => ({ inputCode,
      code: typeof inputCode === 'string' ? 2 : [0, 3, 5, 6, 9, 10, 11, 15, 99].includes(inputCode) ? 13 : inputCode,
      details: 'WGA_AUTH_METADATA', privateDetailsLeaked: false, peer: 'https://docs-policy.test:443', authContext: null })), 'auth status/privacy and logical peer contract');
    equal(row.sendRejected, { code: 8, bytes: null }, 'send ceiling'); equal(row.receiveRejected, { code: 8, bytes: null }, 'receive ceiling');
    equal(row.recovered, { code: 0, bytes: 1 }, 'recovery under cap');
    need(row.fetches === 2 && row.resourcesCheckedBeforeClose === true && row.activeCalls === 0 && row.queuedCalls === 0 && row.bufferedBytes === 0, 'Fetch accounting and cleanup');
  }
  return report;
}
async function execute(base = root) {
  const manifest = JSON.parse(read(base, 'compatibility/documentation-policy.json'));
  const policy = JSON.parse(read(base, 'compatibility/export-policy.json'));
  const contract = JSON.parse(read(base, 'compatibility/exports-contract.json'));
  const { tapResults } = require('./test-evidence.cjs');
  const used = new Set(sources), text = file => { used.add(file); return read(base, file).toString(); };
  const claims = checkClaims(manifest, policy, contract, text, tapResults(read(base, 'verification/tests.tap').toString()));
  const observed = await observeInstalled(base, policy);
  const report = { schemaVersion: 1, status: 'passed', sourceBuild: false, runtimeExecuted: true, runtime: 'installed-node', liveCloud: false,
    metadataRecorded: false, claims, observed, evidence: Object.fromEntries([...used].sort().map(file => [file, hash(read(base, file))])),
    resultInputs: Object.fromEntries(['verification/tests.tap', 'compatibility/exports-contract.json'].map(file => [file, hash(read(base, file))])),
    installedInputs: installedInputs(base) };
  validateDocumentationPolicyReport(report); return report;
}
function validateDocumentationPolicyArtifacts(report, base = root) {
  validateDocumentationPolicyReport(report);
  for (const [file, expected] of Object.entries({ ...report.evidence, ...report.resultInputs, ...report.installedInputs }))
    need(hash(read(base, file)) === expected, `input drift ${file}`);
  equal(report.installedInputs, installedInputs(base), 'complete installed implementation inventory');
  const { tapResults } = require('./test-evidence.cjs');
  const policy = JSON.parse(read(base, 'compatibility/export-policy.json'));
  const manifest = JSON.parse(read(base, 'compatibility/documentation-policy.json'));
  equal(Object.keys(report.evidence).sort(), [...new Set([...sources, 'docs/exports.md',
    ...manifest.claims.flatMap(row => [...row.documents.map(item => item.path), ...row.tests.map(item => item.source)])])].sort(), 'exact claim input inventory');
  equal(Object.keys(report.resultInputs).sort(), ['compatibility/exports-contract.json', 'verification/tests.tap'], 'exact executed result inputs');
  equal(report.claims, checkClaims(manifest, policy,
    JSON.parse(read(base, 'compatibility/exports-contract.json')), file => read(base, file).toString(), tapResults(read(base, 'verification/tests.tap').toString())), 'current documented claims');
  equal(report.observed.absent, policy.entries.filter(row => row.grade === 'U').map(row => row.name), 'current unsupported name inventory');
  return report;
}
module.exports = { checkClaims, observeInstalled, execute, validateDocumentationPolicyReport, validateDocumentationPolicyArtifacts, sources };
if (require.main === module) execute().then(report => {
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/documentation-policy.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, claims: report.claims.length, modes: report.observed.observations.length }));
}).catch(error => { console.error(error.message); process.exitCode = 1; });
