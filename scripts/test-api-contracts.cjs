'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const native = createRequire(path.join(root, 'fixtures/native/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = req('miniflare');
const digest = value => createHash('sha256').update(value).digest('hex');
const report = { status: 'running', sourceBuild: false, liveCloud: false, incomingCloudflareTranslation: false, controlledPeer: true,
  compatibilityDate: '2026-09-21', runs: [], exceptions: [], externalRequests: 0, evidence: {}, installedInputs: {}, nativeInputs: {} };
const sources = ['scripts/test-api-contracts.cjs', 'scripts/api-contract-node.cjs', 'scripts/api-contract-throw.cjs', 'scripts/api-contract-native.cjs', 'scripts/api-contract-evidence.cjs', 'fixtures/shared/catalog-api.mjs', 'fixtures/shared/catalog-api.proto', 'fixtures/worker/catalog-api.mjs', 'fixtures/worker/package-lock.json', 'fixtures/native/package-lock.json'];
async function captureRuntimeExceptions(runtime) {
  const url = await runtime.getInspectorURL(); url.protocol = 'http:'; url.pathname = '/json/list';
  const targets = await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json();
  const target = targets.find(value => value.id === 'core:user:catalog-api'); assert.ok(target);
  const socket = new WebSocket(target.webSocketDebuggerUrl), exceptions = [];
  await new Promise((resolve, reject) => { const timer = setTimeout(() => { socket.close(); reject(new Error('API_INSPECTOR_CONNECT_TIMEOUT')); }, 5000); socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); socket.addEventListener('error', error => { clearTimeout(timer); reject(error); }, { once: true }); });
  let enable;
  let enableTimer;
  const enabled = new Promise((resolve, reject) => { enable = () => { clearTimeout(enableTimer); resolve(); }; enableTimer = setTimeout(() => { socket.close(); reject(new Error('API_INSPECTOR_ENABLE_TIMEOUT')); }, 5000); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id === 1) { assert.equal(message.error, undefined); enable(); }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push({ method: message.method, text: message.params.exceptionDetails.text, description: message.params.exceptionDetails.exception?.description });
  });
  socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable' })); await enabled;
  return { exceptions, close() { socket.close(); } };
}
async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-api-contracts-'));
  try {
    const definition = native('@grpc/proto-loader').loadSync(path.join(root, 'fixtures/shared/catalog-api.proto'), { defaults: true });
    const type = native('protobufjs').loadSync(path.join(root, 'fixtures/shared/catalog-api.proto')).lookupType('catalog.api.nested.Envelope').setup();
    // Compile the actual protobufjs-generated codecs while Node permits code generation;
    // workerd receives static source and performs no eval or filesystem loading.
    // Match the SDK preset's portable Writer factory: BufferWriter relies on
    // native Buffer UTF-8 methods whose default-length behavior differs in Workers.
    const methods = ['encode', 'decode', 'fromObject', 'toObject'].map(key => `${key}: ${type[key].toString()}`).join(',\n');
    const generated = `import p from ${JSON.stringify(native.resolve('protobufjs/minimal'))}; import { Buffer } from 'node:buffer'; const { Reader, util }=p; const Writer={create:()=>new p.Writer()}; const codec={ctor:${type.ctor.toString()},${methods}};codec.ctor.prototype.text=''; const definition=JSON.parse(${JSON.stringify(JSON.stringify(definition))},(key,value)=>value?.type==='Buffer'&&Array.isArray(value.data)?Buffer.from(value.data):value); const method=definition['catalog.api.nested.Echo'].Unary; method.requestSerialize=method.responseSerialize=value=>Buffer.from(codec.encode(codec.fromObject(value)).finish()); method.requestDeserialize=method.responseDeserialize=bytes=>codec.toObject(codec.decode(bytes),{defaults:true}); export default definition;`;
    // Run the actual emitted module in a fresh lexical scope before bundling it.
    // Generator helpers can change between protobuf releases; native proto-loader
    // execution alone cannot establish that the static module carries that scope.
    const staticModuleFile = path.join(scratch, 'static-codecs.mjs');
    fs.writeFileSync(staticModuleFile, generated, { mode: 0o600 });
    const staticDefinition = (await import(pathToFileURL(staticModuleFile).href)).default;
    const staticMethod = staticDefinition['catalog.api.nested.Echo'].Unary;
    const nativeMethod = definition['catalog.api.nested.Echo'].Unary;
    const calibrationPayloads = ['', '안녕 ☃', 'x'.repeat(96)];
    for (const text of calibrationPayloads) {
      const bytes = nativeMethod.requestSerialize({ text });
      assert.deepEqual(staticMethod.requestSerialize({ text }), bytes, 'standalone static codec/native wire');
      assert.deepEqual(staticMethod.responseDeserialize(bytes), nativeMethod.responseDeserialize(bytes), 'standalone static codec/native value');
    }
    assert.deepEqual(staticMethod.responseDeserialize(Buffer.alloc(0)), nativeMethod.responseDeserialize(Buffer.alloc(0)), 'standalone static codec/native empty wire');
    assert.throws(() => nativeMethod.requestSerialize(null), TypeError, 'native codec invalid object control');
    assert.throws(() => staticMethod.requestSerialize(null), TypeError, 'standalone static codec invalid object');
    assert.throws(() => nativeMethod.responseDeserialize(Buffer.from([128])), RangeError, 'native codec truncated varint control');
    assert.throws(() => staticMethod.responseDeserialize(Buffer.from([128])), RangeError, 'standalone static codec truncated varint');
    report.protoLoader = { version: native('@grpc/proto-loader/package.json').version, protobufjs: native('protobufjs/package.json').version,
      transformation: 'loadSync real proto; preserve full descriptor graph; precompile actual protobufjs encode/decode/fromObject/toObject static functions',
      staticCodecCalibration: { payloads: calibrationPayloads, standaloneModule: true, nativeSerializationMatched: true,
        nativeDeserializationMatched: true, emptyWireMatched: true, malformedObjectRejected: true, malformedWireRejected: true },
      descriptorSha256: digest(JSON.stringify(definition)), staticModuleSha256: digest(generated), descriptorPath: 'verification/api-contracts/package-definition.json', staticModulePath: 'verification/api-contracts/static-codecs.mjs' };
    fs.mkdirSync(path.join(root, 'verification/api-contracts'), { recursive: true });
    fs.writeFileSync(path.join(root, report.protoLoader.descriptorPath), JSON.stringify(definition));
    fs.writeFileSync(path.join(root, report.protoLoader.staticModulePath), generated);
    report.generatedArtifacts = { [report.protoLoader.descriptorPath]: report.protoLoader.descriptorSha256, [report.protoLoader.staticModulePath]: report.protoLoader.staticModuleSha256 };
    const banner = `import * as b from 'node:buffer';import * as e from 'node:events';import * as s from 'node:stream';import * as z from 'node:zlib';const modules={'node:buffer':b,'node:events':e,'node:stream':s,'node:zlib':z};const require=n=>{if(Object.hasOwn(modules,n))return modules[n];throw new Error('Unsupported runtime require: '+n);};`;
    const bundle = await req('esbuild').build({ absWorkingDir: root, entryPoints: ['fixtures/worker/catalog-api.mjs'], bundle: true, write: false, metafile: true,
      format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], banner: { js: banner },
      plugins: [{ name: 'actual-proto-loader-definition', setup(build) {
        build.onResolve({ filter: /^catalog-api-definition$/ }, () => ({ path: 'definition', namespace: 'catalog' }));
        build.onLoad({ filter: /.*/, namespace: 'catalog' }, () => ({ contents: generated, resolveDir: root, loader: 'js' }));
      } }] });
    report.bundleSha256 = digest(bundle.outputFiles[0].contents);
    for (const file of Object.keys(bundle.metafile.inputs).filter(file => file.includes('/node_modules/'))) {
      report.installedInputs[file] = digest(fs.readFileSync(path.join(root, file)));
    }
    for (const entry of ['index', 'adapter', 'config']) {
      const file = path.relative(root, req.resolve(`@grpc/grpc-js${entry === 'index' ? '' : `/${entry}`}`)); report.installedInputs[file] = digest(fs.readFileSync(path.join(root, file)));
    }
    for (const name of ['@grpc/grpc-js', '@grpc/proto-loader', 'protobufjs']) {
      const file = path.relative(root, native.resolve(`${name}/package.json`)); report.nativeInputs[file] = digest(fs.readFileSync(path.join(root, file)));
    }
    report.evidence = Object.fromEntries(sources.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
    report.workerd = req('workerd/package.json').version; report.miniflare = req('miniflare/package.json').version; report.node = process.version;
    report.native = await require('./api-contract-native.cjs')();
    report.transformerComparison = 'in-place argument mutation with two interceptors; replacement of the argument object is outside this native parity assertion';
    for (const file of Object.keys(require.cache).filter(file => file.startsWith(path.join(root, 'fixtures/native/node_modules/')))) report.nativeInputs[path.relative(root, file)] = digest(fs.readFileSync(file));
    for (const mode of ['cloudflare', 'grpc-web']) {
      const output = path.join(scratch, mode + '.json');
      const child = spawnSync(process.execPath, ['scripts/api-contract-node.cjs', mode, output], { cwd: root, encoding: 'utf8', timeout: 30000 });
      assert.equal(child.status, 0, child.stderr); report.runs.push(...JSON.parse(fs.readFileSync(output)));
      const exceptionOutput = path.join(scratch, mode + '-throw.json');
      const throwChild = spawnSync(process.execPath, ['scripts/api-contract-throw.cjs', mode, exceptionOutput], { cwd: root, encoding: 'utf8', timeout: 10000 });
      assert.equal(throwChild.status, 1, 'Node application throw must remain fatal');
      assert.ok(throwChild.stderr.includes(`CATALOG_API016_APPLICATION_THROW_${mode}`));
      report.exceptions.push({ runtime: 'node', mode, fatalExitCode: throwChild.status, ...JSON.parse(fs.readFileSync(exceptionOutput)) });
      const exceptions = [];
      class CaptureLog extends Log { error(error) { exceptions.push({ message: String(error.message || error) }); } }
      const runtime = new Miniflare(convertV4MiniflareOptions({ log: new CaptureLog(LogLevel.ERROR), modules: true, name: 'catalog-api', inspectorPort: 0, script: bundle.outputFiles[0].text,
        compatibilityDate: report.compatibilityDate, compatibilityFlags: ['nodejs_compat'], bindings: { MODE: mode },
        outboundService() { report.externalRequests++; throw new Error('API_CONTRACT_EXTERNAL_REQUEST'); } }));
      const inspector = await captureRuntimeExceptions(runtime);
      try {
        for (const invocation of ['cold', 'warm']) {
          const response = await runtime.dispatchFetch(`https://entry.fixture.invalid/${invocation}`, { signal: AbortSignal.timeout(30000) });
          const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); report.runs.push({ runtime: 'workerd', invocation, ...result });
        }
        const response = await runtime.dispatchFetch('https://entry.fixture.invalid/throw', { signal: AbortSignal.timeout(10000) });
        const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
        report.runs.push({ runtime: 'workerd', invocation: 'throw', ...result });
        await new Promise(resolve => setTimeout(resolve, 50));
        report.exceptions.push({ runtime: 'workerd', mode, exceptions: inspector.exceptions, logs: exceptions });
      } finally { inspector.close(); await runtime.dispose(); }
    }
    for (const run of report.runs) for (const result of run.results) {
      const baseline = report.native.results.find(value => value.id === result.id);
      if (baseline && result.id !== 'API-011') {
        assert.deepEqual(result.calls[0].trace, baseline.trace, `${run.runtime}/${run.mode}/${result.id} native trace`);
        if (result.id === 'API-007') assert.deepEqual(result.order, baseline.order);
        result.nativeCompared = true;
        if (result.id === 'API-007') assert.equal(result.receipts[0].wire, baseline.wires[0]);
      }
      if (result.id === 'API-004') { assert.equal(digest(result.descriptorGraph), report.protoLoader.descriptorSha256); result.fullDescriptorGraphPreserved = true; delete result.descriptorGraph; }
      if (result.id === 'API-011') result.nativeDivergence = { adapterCode: 12, nativeCode: baseline.callbacks[0].code, reason: 'pinned native unary waits after first message until deadline; adapter enforces cardinality promptly' };
    }
    report.results = report.runs.flatMap(run => run.results.map(value => ({ runtime: run.runtime, invocation: run.invocation, ...value })));
    for (const value of report.exceptions.filter(value => value.runtime === 'node')) report.results.push({ runtime: 'node', invocation: 'throw', mode: value.mode,
      id: 'API-016', status: 'passed', rpcCount: 1, fetchCount: value.fetchCount, authCalls: 0, receipts: value.receipts,
      calls: [{ trace: value.trace, callbacks: value.callbacks, statuses: value.statuses, diagnostics: value.diagnostics }], cleanup: value.cleanup,
      activeCalls: value.activeCalls, resourcesIdle: ['activeCalls', 'queuedCalls', 'bufferedBytes'].every(key => value.usage[key] === 0),
      applicationThrow: true, observerTerminalCode: value.observer[0]?.statusCode, observerTerminalCount: value.observer.length, callbackStatus: value.callbacks[0]?.code, statusEvents: value.statuses.length });
    report.caseCount = report.results.length; report.rpcCount = report.results.reduce((sum, row) => sum + row.rpcCount, 0); report.fetchCount = report.results.reduce((sum, row) => sum + row.fetchCount, 0);
    report.runtimeDisposed = true; report.cleanupVerifiedBeforeDispose = true; report.status = 'passed';
    require('./api-contract-evidence.cjs').validateApiContractsReport(report);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
const timeout = setTimeout(() => { console.error('API_CONTRACTS_TIMEOUT'); process.exit(1); }, 90000);
main().catch(error => { report.status = 'failed'; report.diagnostic = error.message; console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(timeout);
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/api-contracts.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, runs: report.runs.length, report: 'verification/api-contracts.json' }));
});
