'use strict';
// Real SDKs share a GAX constructor cache inside each workerd isolate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { buildGoogleWorker } = require('./build-google-worker.cjs');
const root = path.resolve(__dirname, '..');
const googleRequire = createRequire(path.join(root, 'fixtures/google/package.json'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const protobuf = googleRequire('protobufjs');
const schema = (sdk, file) => protobuf.Root.fromJSON(JSON.parse(fs.readFileSync(path.join(
  path.dirname(googleRequire.resolve(`@google-cloud/${sdk}/package.json`)), 'build/protos', file), 'utf8')));
const datastore = schema('datastore', 'protos.json');
const firestore = schema('firestore', 'v1.json');
const secret = schema('secret-manager', 'protos.json');
const cases = {
  '/google.datastore.v1.Datastore/Lookup': { service: 'datastore', request: datastore.lookupType('google.datastore.v1.LookupRequest'),
    response: datastore.lookupType('google.datastore.v1.LookupResponse'), reply: request => ({ missing: [{ entity: { key: request.keys[0] } }] }),
    identity: request => request.keys[0].path[0].name },
  '/google.firestore.v1.Firestore/BatchGetDocuments': { service: 'firestore', request: firestore.lookupType('google.firestore.v1.BatchGetDocumentsRequest'),
    response: firestore.lookupType('google.firestore.v1.BatchGetDocumentsResponse'), reply: request => ({ missing: request.documents[0], readTime: { seconds: 1 } }),
    identity: request => request.documents[0].split('/').at(-1) },
  '/google.cloud.secretmanager.v1.SecretManagerService/GetSecret': { service: 'secretmanager', request: secret.lookupType('google.cloud.secretmanager.v1.GetSecretRequest'),
    response: secret.lookupType('google.cloud.secretmanager.v1.Secret'), reply: request => ({ name: request.name }),
    identity: request => request.name.split('/').at(-1) },
};
function frame(bytes, trailer = false) {
  const buffer = Buffer.alloc(5 + bytes.length);
  buffer[0] = trailer ? 128 : 0;
  buffer.writeUInt32BE(bytes.length, 1);
  buffer.set(bytes, 5);
  return buffer;
}
const temporaryBase = path.join(root, '.wga-build');
fs.mkdirSync(temporaryBase, { recursive: true });
const temporary = fs.mkdtempSync(path.join(temporaryBase, 'gax-mode-isolation-'));
const report = { status: 'running', cacheOrders: 0, workerInvocations: 0, requests: 0,
  realGoogleSDKs: 3, concurrentTransportInstances: 3, plainClientsBeforeAndAfter: false,
  sameModeDifferentGateways: false, authIsolation: false, networkRequests: 0,
  cloudflareTranslation: false, liveGoogle: false };
async function main() {
  const bundle = await buildGoogleWorker({ entry: path.join(root, 'fixtures/google/mixed-mode-worker.mjs'), outdir: temporary });
  const config = path.join(temporary, 'wrangler.json');
  fs.writeFileSync(config, JSON.stringify({ name: 'wga-mixed-mode-local', main: bundle.main,
    compatibility_date: '2026-09-21', compatibility_flags: ['nodejs_compat'], workers_dev: false }));
  const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
  for (const name of Object.keys(environment)) if (/^(?:CF_|CLOUDFLARE_|WGA_)/.test(name)) delete environment[name];
  const output = path.join(temporary, 'dry-run');
  execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'),
    'deploy', '--dry-run', '--config', config, '--outdir', output, '--no-autoconfig'],
  { cwd: root, env: environment, stdio: 'pipe', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const script = fs.readFileSync(path.join(output, 'worker.js'), 'utf8');
  report.bundleSha256 = createHash('sha256').update(script).digest('hex');
  report.sdkVersions = bundle.manifest.packages.filter(item => item.name.startsWith('@google-cloud/'))
    .map(({ name, version }) => ({ name, version }));
  for (const order of ['default-before', 'cloudflare', 'gateway-a']) {
    const observed = [];
    const outboundErrors = [];
    const worker = new Miniflare(convertV4MiniflareOptions({
      log: new Log(LogLevel.NONE), modules: true, script,
      compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'],
      outboundService: async request => {
        try {
        const url = new URL(request.url);
        const testCase = cases[url.pathname];
        assert.ok(testCase, `Unexpected RPC ${url.pathname}`);
        const bytes = Buffer.from(await request.arrayBuffer());
        assert.equal(bytes[0], 0);
        assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
        const decoded = testCase.request.decode(bytes.subarray(5));
        const identity = testCase.identity(decoded);
        const label = identity.slice(identity.indexOf(`-${testCase.service}-`) + testCase.service.length + 2);
        const gateway = label.startsWith('gateway');
        // Payload, authentication and route must belong to the same client.
        assert.equal(request.headers.get('x-fixture-client'), identity);
        assert.equal(request.headers.get('authorization'), `Bearer fixture-${identity}`);
        assert.equal(request.headers.get('x-serverless-authorization'), gateway ? `Bearer gateway-${identity}` : null);
        const contentType = gateway ? 'application/grpc-web+proto' : 'application/grpc-web';
        assert.equal(url.origin, gateway ? `https://${label}.invalid` : `https://${testCase.service}.googleapis.com`, `${order}/${identity}`);
        assert.equal(request.headers.get('content-type'), contentType, `${order}/${identity}`);
        assert.equal(request.headers.get('accept'), contentType);
        observed.push(identity);
        report.requests++;
        // Keep concurrent clients pending together across the outbound boundary.
        await new Promise(resolve => setImmediate(resolve));
        const reply = testCase.response.encode(testCase.response.fromObject(testCase.reply(decoded))).finish();
        return new Response(Buffer.concat([frame(reply), frame(Buffer.from('grpc-status: 0\r\n'), true)]),
          { headers: { 'content-type': contentType } });
        } catch (error) {
          outboundErrors.push(error.message);
          return new Response(frame(Buffer.from('grpc-status: 7\r\n'), true),
            { headers: { 'content-type': 'application/grpc-web' } });
        }
      },
    }));
    try {
      for (const invocation of ['first', 'second']) {
        const response = await worker.dispatchFetch(`https://fixture.test/${order}/${invocation}`);
        const body = await response.text();
        assert.deepEqual(outboundErrors, [], `${order}/${invocation}: outgoing request invariants`);
        assert.equal(response.status, 200, `${order}/${invocation}: ${body}`);
        const result = JSON.parse(body);
        assert.equal(result.status, 'passed');
        const expected = ['datastore', 'firestore', 'secretmanager'].flatMap(service =>
          ['default-before', 'cloudflare', 'gateway-a', 'gateway-b', 'default-after'].map(label => `${invocation}-${service}-${label}`));
        assert.deepEqual(result.results.sort(), expected.sort());
        assert.deepEqual(observed.filter(identity => identity.startsWith(invocation)).sort(), expected.sort());
        report.workerInvocations++;
      }
      report.cacheOrders++;
    } finally { await worker.dispose(); }
  }
  Object.assign(report, { status: 'passed', plainClientsBeforeAndAfter: true,
    sameModeDifferentGateways: true, authIsolation: true });
}
main().catch(error => { report.status = 'failed'; console.error(error); process.exitCode = 1; })
  .finally(() => {
    fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification/workers-gax-modes.json'), JSON.stringify(report, null, 2) + '\n');
    fs.rmSync(temporary, { recursive: true, force: true });
    console.log(JSON.stringify(report));
  });
