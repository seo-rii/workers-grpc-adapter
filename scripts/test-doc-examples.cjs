'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { sources, selections, checks, inventoryDocumentation, renderExamples, validateDocExamplesArtifacts } = require('./doc-example-evidence.cjs');
const { digest } = require('./documentation-sources.cjs');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const report = { schemaVersion: 1, status: 'running', runtimeExecuted: false, workerdExecuted: false,
  sourceBuild: false, liveCloud: false, liveGoogle: false, realGoogleSDK: false, cloudflareTranslation: false, allExamplesExecuted: false,
  controlledPeer: true, compatibilityDate: '2026-09-21', runtimeDisposed: false,
  scope: 'Two exact README alternatives in separate local workerd isolates; remaining fenced blocks are expected and unexecuted',
  checks, runs: [], evidence: {}, installedInputs: {}, generatedArtifacts: {} };
function record(file, bytes) { fs.writeFileSync(path.join(root, file), bytes, { mode: 0o600 }); report.generatedArtifacts[file] = digest(bytes); }
function frame(payload, flag = 0) {
  const head = Buffer.alloc(5); head[0] = flag; head.writeUInt32BE(payload.length, 1); return Buffer.concat([head, payload]);
}
async function main() {
  const inventory = inventoryDocumentation(root);
  report.documents = inventory.documents;
  report.examples = inventory.examples.map(row => ({ ...row, status: row.classification === 'execute' ? 'pending' : 'expected', runtimeExecuted: false }));
  const { Miniflare, convertV4MiniflareOptions } = req('miniflare'), esbuild = req('esbuild');
  report.node = process.version;
  for (const name of ['miniflare', 'workerd', 'esbuild']) {
    const file = path.relative(root, req.resolve(name + '/package.json'));
    report[name] = req(name + '/package.json').version; report.installedInputs[file] = digest(fs.readFileSync(path.join(root, file)));
  }
  const pkgPath = path.relative(root, req.resolve('@grpc/grpc-js/package.json'));
  const pkg = req('@grpc/grpc-js/package.json');
  const locked = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/worker/package-lock.json'))).packages['node_modules/@grpc/grpc-js'];
  report.installedPackage = { alias: '@grpc/grpc-js', name: pkg.name, version: pkg.version, path: pkgPath,
    lockfile: 'fixtures/worker/package-lock.json', resolved: locked.resolved, integrity: locked.integrity,
    tarballSha256: digest(fs.readFileSync(path.join(root, 'artifacts', `workers-grpc-adapter-${pkg.version}.tgz`))) };
  report.installedInputs[pkgPath] = digest(fs.readFileSync(path.join(root, pkgPath)));
  report.evidence = Object.fromEntries([...new Set([...sources, ...inventory.documents.map(doc => doc.file)])].sort().map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  const banner = `import * as b from 'node:buffer';import * as e from 'node:events';import * as s from 'node:stream';import * as z from 'node:zlib';const modules={'node:buffer':b,'node:events':e,'node:stream':s,'node:zlib':z};const require=n=>{if(Object.hasOwn(modules,n))return modules[n];throw new Error('Unsupported runtime require: '+n);};`;
  fs.mkdirSync(path.join(root, 'verification/doc-examples'), { recursive: true });
  for (const selection of selections) {
    const example = report.examples.find(row => row.id === selection.id), requests = [], responseStates = [];
    const bundlePath = `verification/doc-examples/${selection.mode}.mjs`, metafilePath = `verification/doc-examples/${selection.mode}-metafile.json`;
    const bundle = await esbuild.build({ absWorkingDir: root, entryPoints: ['fixtures/docs/worker.mjs'], outfile: bundlePath,
      bundle: true, write: false, metafile: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'],
      nodePaths: [path.join(root, 'fixtures/worker/node_modules')], banner: { js: banner },
      plugins: [{ name: 'documentation-consumer', setup(build) {
        build.onResolve({ filter: /^doc-example-consumer$/ }, () => ({ path: path.join(root, selection.consumer) }));
      } }] });
    const bundleInputs = {};
    for (const file of Object.keys(bundle.metafile.inputs).sort()) {
      bundleInputs[file] = digest(fs.readFileSync(path.join(root, file)));
      if (file.includes('/node_modules/')) report.installedInputs[file] = bundleInputs[file];
    }
    record(bundlePath, bundle.outputFiles[0].contents); record(metafilePath, JSON.stringify(bundle.metafile, null, 2) + '\n');
    let externalRequests = 0, runtimeResult;
    const origin = selection.mode === 'cloudflare' ? 'https://service.example' : 'https://gateway.example';
    const contentType = selection.mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
    const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, name: `doc-example-${selection.mode}`,
      script: bundle.outputFiles[0].text, compatibilityDate: report.compatibilityDate, compatibilityFlags: ['nodejs_compat'],
      outboundService: async request => {
        if (request.url !== origin + '/package.Service/Method') { externalRequests++; throw new Error('DOC_EXAMPLE_UNEXPECTED_OUTBOUND'); }
        const payload = Buffer.from(await request.arrayBuffer());
        assert.equal(payload.toString('hex'), '00000000040a026f6b');
        const timeout = request.headers.get('grpc-timeout'), parsed = /^(\d+)([HMSmun])$/.exec(timeout); assert.ok(parsed);
        const receipt = { url: request.url, method: request.method, contentType: request.headers.get('content-type'),
          accept: request.headers.get('accept'), grpcWeb: request.headers.get('x-grpc-web'), payloadHex: payload.toString('hex'), timeout,
          defaultTimeoutMs: Number(parsed[1]) * { H: 3600000, M: 60000, S: 1000, m: 1, u: .001, n: .000001 }[parsed[2]], responseFrames: 2, responseReleased: false };
        requests.push(receipt);
        const chunks = [payload, frame(Buffer.from('grpc-status: 0\r\n'), 128)]; let index = 0;
        const body = new ReadableStream({ pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else { receipt.responseReleased = true; controller.close(); } },
          cancel() { receipt.responseReleased = true; } }, { highWaterMark: 0 });
        responseStates.push(body);
        return new Response(body, { headers: { 'content-type': contentType } });
      } }));
    try {
      const response = await runtime.dispatchFetch('https://documentation.fixture.invalid/', { signal: AbortSignal.timeout(20000) });
      const text = await response.text(); assert.equal(response.status, 200, text); runtimeResult = JSON.parse(text);
      assert.equal(requests.length, 1);
      assert.ok(requests.every(row => row.responseReleased) && responseStates.every(body => !body.locked), 'response released before runtime disposal');
    } finally { await runtime.dispose(); }
    report.runs.push({ id: selection.id, mode: selection.mode, status: 'passed', freshIsolate: true, sourceSha256: example.sha256,
      consumerSha256: report.evidence[selection.consumer], sourceMatchesConsumer: true, runtimeDisposed: true, externalRequests,
      bundlePath, bundleSha256: report.generatedArtifacts[bundlePath], metafilePath, metafileSha256: report.generatedArtifacts[metafilePath],
      bundleInputs, requests, ...runtimeResult });
    example.status = 'passed'; example.runtimeExecuted = true;
  }
  report.counts = { documents: report.documents.length, blocks: report.examples.length, executed: 2, expected: report.examples.length - 2 };
  report.rpcCount = report.runs.reduce((sum, run) => sum + run.rpcCount, 0);
  report.fetchCount = report.runs.reduce((sum, run) => sum + run.fetchCount, 0);
  report.externalRequests = report.runs.reduce((sum, run) => sum + run.externalRequests, 0);
  report.runtimeDisposed = true; report.runtimeExecuted = true; report.workerdExecuted = true; report.status = 'passed';
  record('verification/doc-examples.md', renderExamples(report));
  validateDocExamplesArtifacts(report, root);
}
const timeout = setTimeout(() => { console.error('DOC_EXAMPLES_TIMEOUT'); process.exit(1); }, 60000);
main().catch(error => { report.status = 'failed'; report.reason = error.message; console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(timeout); fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/doc-examples.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, counts: report.counts, report: 'verification/doc-examples.json' }));
});
