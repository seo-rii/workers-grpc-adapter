'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { discoverMarkdown, extractFences, readDocumentation, digest } = require('../scripts/documentation-sources.cjs');
const { sources, selections, checks, inventoryDocumentation, renderExamples, validateDocExamplesReport, validateDocExamplesArtifacts } = require('../scripts/doc-example-evidence.cjs');
function temporary(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doc-examples-test-'));
  try { return run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function write(root, file, value) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), value); }
function copyInventory(directory) {
  for (const doc of readDocumentation(root)) write(directory, doc.file, doc.text);
  for (const file of ['compatibility/doc-examples.json', ...selections.map(row => row.consumer)]) write(directory, file, fs.readFileSync(path.join(root, file)));
}
test('DOC examples fence extraction preserves exact source and rejects unfinished fences', () => {
  const text = 'Intro\r\n```js\r\nconst text = "~~~";\r\n```\r\n\n~~~~text\n```nested\n~~~\n~~~~\n';
  const rows = extractFences('guide.md', text);
  assert.deepEqual(rows.map(row => ({ id: row.id, language: row.language, start: row.startLine, end: row.endLine, content: row.content })), [
    { id: 'guide.md#fence-1', language: 'js', start: 2, end: 4, content: 'const text = "~~~";\r\n' },
    { id: 'guide.md#fence-2', language: 'text', start: 6, end: 9, content: '```nested\n~~~\n' },
  ]);
  assert.equal(rows[0].sha256, digest('const text = "~~~";\r\n'));
  assert.equal(extractFences('empty.md', '```\n```\n')[0].content, '');
  assert.equal(extractFences('quote.md', '> ```sh\n> example\n> ```\n')[0].content, '> example\n');
  assert.equal(extractFences('list.md', '- ```js\n  value;\n  ```\n')[0].content, '  value;\n');
  assert.equal(extractFences('nested-quote.md', '> > ~~~js\n> > value;\n> > ~~~\n').length, 1);
  assert.throws(() => extractFences('broken.md', '```js\nconst open = true;\n'), /UNCLOSED.*broken.md:1/);
  assert.throws(() => extractFences('mismatch.md', '~~~js\nvalue\n```\n'), /UNCLOSED/);
});
test('DOC examples discover all maintained roots and exclude generated dependencies and bookkeeping', () => temporary(directory => {
  for (const file of ['README.md', 'NEW.md', '.github/guide.md', 'docs/spec/old.md', 'fixtures/new/README.md', 'vendor/README.md',
    'RISK_REGISTER.md', 'STAGING.md', 'DONE.md', 'MISTAKES.md', 'fixtures/node_modules/dep/README.md', 'fixtures/.cache/README.md', 'verification/report.md']) write(directory, file, 'text');
  assert.deepEqual(discoverMarkdown(directory), ['.github/guide.md', 'NEW.md', 'README.md', 'docs/spec/old.md', 'fixtures/new/README.md', 'vendor/README.md']);
  fs.symlinkSync(path.join(directory, 'README.md'), path.join(directory, 'docs/link.md'));
  assert.throws(() => discoverMarkdown(directory), /WGA_DOC_SOURCE_SYMLINK.*docs\/link.md/);
  fs.unlinkSync(path.join(directory, 'docs/link.md'));
  fs.symlinkSync(path.join(directory, 'vendor'), path.join(directory, 'docs/shared'));
  assert.throws(() => discoverMarkdown(directory), /WGA_DOC_SOURCE_SYMLINK.*docs\/shared/);
  fs.unlinkSync(path.join(directory, 'docs/shared'));
  fs.renameSync(path.join(directory, 'docs'), path.join(directory, 'elsewhere'));
  fs.symlinkSync(path.join(directory, 'elsewhere'), path.join(directory, 'docs'));
  assert.throws(() => discoverMarkdown(directory), /WGA_DOC_SOURCE_SYMLINK.*docs/);
}));
test('DOC examples inventory keeps two exact consumers and explicitly classifies every unexecuted fence', () => {
  const inventory = inventoryDocumentation(root);
  assert.equal(inventory.examples.filter(row => row.classification === 'execute').length, 2);
  assert.ok(inventory.examples.length > 50);
  assert.ok(inventory.examples.some(row => row.category === 'historical-specification'));
  for (const row of inventory.examples.filter(row => row.classification !== 'execute')) assert.equal(row.classification, 'expected');
});
test('DOC examples reject missing, new, stale and overclaimed fences or changed consumers', () => {
  const cases = [
    ['missing manifest row', (directory, manifest) => manifest.examples.pop()],
    ['duplicate manifest row', (directory, manifest) => manifest.examples.push(manifest.examples[0])],
    ['reordered manifest row', (directory, manifest) => manifest.examples.reverse()],
    ['unknown fence', directory => write(directory, 'docs/new-example.md', '```js\nnewExample();\n```\n')],
    ['removed fence', directory => write(directory, 'README.md', fs.readFileSync(path.join(directory, 'README.md'), 'utf8').replace(/```sh\n[\s\S]*?```\n/, ''))],
    ['stale hash', (directory, manifest) => { manifest.examples[0].sha256 = '0'.repeat(64); }],
    ['stale language', (directory, manifest) => { manifest.examples[0].language = 'python'; }],
    ['stale ordinal', (directory, manifest) => { manifest.examples[0].ordinal = 55; }],
    ['stale source', directory => write(directory, 'README.md', fs.readFileSync(path.join(directory, 'README.md'), 'utf8').replace("defaultTimeoutMs: 10_000", "defaultTimeoutMs: 20_000"))],
    ['changed consumer', directory => fs.appendFileSync(path.join(directory, 'fixtures/docs/cloudflare.mjs'), 'client.close();\n')],
    ['wrong consumer', (directory, manifest) => { manifest.examples.find(row => row.id === 'README.md#fence-5').consumer = 'fixtures/docs/grpc-web.mjs'; }],
    ['unexecuted overclaim', (directory, manifest) => { manifest.examples[0].classification = 'execute'; }],
    ['missing reason', (directory, manifest) => { manifest.examples[0].reason = ''; }],
    ['invented category', (directory, manifest) => { manifest.examples[0].category = 'passed-check'; }],
    ['historical overclaim', (directory, manifest) => { manifest.examples.find(row => row.file.startsWith('docs/spec/')).category = 'illustrative-code'; }],
  ];
  for (const [name, mutate] of cases) temporary(directory => {
    copyInventory(directory);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'compatibility/doc-examples.json')));
    mutate(directory, manifest);
    assert.throws(() => inventoryDocumentation(directory, manifest), /WGA_DOC_EXAMPLES_INVALID/, name);
  });
});

// Independent synthetic receipts exercise report validation only. These are not
// runtime evidence and never written to verification/ or used by the driver.
function syntheticReport() {
  const h = 'a'.repeat(64), prefix = 'fixtures/worker/node_modules/@grpc/grpc-js/';
  const documents = [{ file: 'README.md', sha256: h, fences: 6 }, { file: 'docs/spec/historical.md', sha256: h, fences: 1 }];
  const examples = Array.from({ length: 6 }, (_, index) => {
    const selected = selections.find(row => row.id === `README.md#fence-${index + 1}`);
    return { id: `README.md#fence-${index + 1}`, file: 'README.md', ordinal: index + 1, language: selected ? 'js' : 'text', sha256: h,
      classification: selected ? 'execute' : 'expected', category: selected ? 'installed-workerd-consumer' : 'diagram', reason: 'Synthetic fixture for validator mutation tests only.',
      ...(selected ? { consumer: selected.consumer } : {}), startLine: 1 + index * 4, endLine: 3 + index * 4, status: selected ? 'passed' : 'expected', runtimeExecuted: !!selected };
  });
  examples.push({ id: 'docs/spec/historical.md#fence-1', file: 'docs/spec/historical.md', ordinal: 1, language: 'ts', sha256: h,
    classification: 'expected', category: 'historical-specification', reason: 'Historical design is explicitly not runtime evidence.', startLine: 1, endLine: 3, status: 'expected', runtimeExecuted: false });
  const report = { schemaVersion: 1, status: 'passed', runtimeExecuted: true, workerdExecuted: true,
    sourceBuild: false, liveCloud: false, liveGoogle: false, realGoogleSDK: false, cloudflareTranslation: false, allExamplesExecuted: false,
    controlledPeer: true, compatibilityDate: '2026-09-21', runtimeDisposed: true,
    scope: 'Two exact README alternatives in separate local workerd isolates; remaining fenced blocks are expected and unexecuted',
    checks: [...checks], node: 'v22.21.1', miniflare: '5.20260921.0-alpha', workerd: '1.20260921.0', esbuild: '0.28.2', documents, examples,
    counts: { documents: 2, blocks: 7, executed: 2, expected: 5 },
    evidence: Object.fromEntries([...sources, ...documents.map(row => row.file)].map(file => [file, h])),
    installedInputs: Object.fromEntries(['package.json', 'dist/index.mjs', 'dist/config.mjs', 'dist/index.js', 'dist/config.js'].map(file => [prefix + file, h])),
    installedPackage: { alias: '@grpc/grpc-js', name: 'workers-grpc-adapter', version: '0.0.1', path: prefix + 'package.json',
      lockfile: 'fixtures/worker/package-lock.json', resolved: 'file:../../artifacts/workers-grpc-adapter-0.0.1.tgz', integrity: 'sha512-' + 'A'.repeat(86) + '==', tarballSha256: h },
    runs: [], rpcCount: 2, fetchCount: 2, externalRequests: 0 };
  for (const selected of selections) {
    const origin = selected.mode === 'cloudflare' ? 'https://service.example' : 'https://gateway.example';
    const contentType = selected.mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
    const url = origin + '/package.Service/Method';
    report.runs.push({ id: selected.id, mode: selected.mode, status: 'passed', freshIsolate: true, sourceSha256: h, consumerSha256: h, sourceMatchesConsumer: true,
      runtimeDisposed: true, clientClosed: true, channelActiveCalls: 0, externalRequests: 0,
      callbacks: [{ code: 0, value: '0a026f6b' }], statusCodes: [0], rpcCount: 1, fetchCount: 1,
      fetchIntents: [{ url, method: 'POST', grpcWeb: selected.mode === 'cloudflare' ? 'convert' : 'passthrough', contentType, redirect: 'manual', payloadHex: '00000000040a026f6b' }],
      requests: [{ url, method: 'POST', contentType, accept: contentType, grpcWeb: '1', payloadHex: '00000000040a026f6b', timeout: '10000000u', defaultTimeoutMs: 10000, responseFrames: 2, responseReleased: true }],
      diagnostics: { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false },
      execution: { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0, parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 },
      bundlePath: `verification/doc-examples/${selected.mode}.mjs`, bundleSha256: h,
      metafilePath: `verification/doc-examples/${selected.mode}-metafile.json`, metafileSha256: h,
      bundleInputs: { [selected.consumer]: h, 'fixtures/docs/worker.mjs': h, [prefix + 'dist/index.mjs']: h } });
  }
  report.generatedArtifacts = Object.fromEntries([...report.runs.flatMap(run => [[run.bundlePath, run.bundleSha256], [run.metafilePath, run.metafileSha256]]), ['verification/doc-examples.md', digest(renderExamples(report))]]);
  return report;
}
test('DOC examples report rejects fabricated runtime counts, drifted receipts and status overclaims', () => {
  assert.doesNotThrow(() => validateDocExamplesReport(syntheticReport()));
  const cases = [
    ['runtime not executed', r => { r.runtimeExecuted = false; }], ['workerd not executed', r => { r.workerdExecuted = false; }],
    ['source build', r => { r.sourceBuild = true; }], ['edge conversion claim', r => { r.cloudflareTranslation = true; }],
    ['live claim', r => { r.liveCloud = true; }], ['all examples claim', r => { r.allExamplesExecuted = true; }],
    ['expected marked passed', r => { r.examples[0].status = 'passed'; }], ['expected executed', r => { r.examples[0].runtimeExecuted = true; }],
    ['history upgraded', r => { r.examples.at(-1).classification = 'execute'; }], ['history disguised', r => { r.examples.at(-1).category = 'illustrative-code'; }],
    ['missing row', r => { r.examples.pop(); }], ['missing document', r => { r.documents.pop(); }],
    ['missing source', r => { delete r.evidence['scripts/test-doc-examples.cjs']; }], ['missing installed source', r => { delete r.installedInputs['fixtures/worker/node_modules/@grpc/grpc-js/dist/index.js']; }],
    ['unlocked package', r => { r.installedPackage.integrity = ''; }], ['native package claim', r => { r.installedPackage.name = '@grpc/grpc-js'; }],
    ['source mismatch', r => { r.runs[0].sourceSha256 = 'b'.repeat(64); }], ['consumer mismatch', r => { r.runs[0].consumerSha256 = 'b'.repeat(64); }],
    ['source match missing', r => { r.runs[0].sourceMatchesConsumer = false; }], ['reused isolate', r => { r.runs[0].freshIsolate = false; }],
    ['missing execution', r => { r.runs.pop(); }], ['duplicate mode', r => { r.runs[1].mode = 'cloudflare'; }],
    ['callback wrong payload', r => { r.runs[0].callbacks[0].value = '00'; }], ['duplicate callback', r => { r.runs[0].callbacks.push(r.runs[0].callbacks[0]); }],
    ['duplicate status', r => { r.runs[0].statusCodes.push(0); }], ['wrong status', r => { r.runs[0].statusCodes[0] = 14; }],
    ['zero RPC', r => { r.runs[0].rpcCount = 0; }], ['extra fetch', r => { r.runs[0].fetchCount = 2; }],
    ['aggregate calls', r => { r.rpcCount = 3; }], ['aggregate fetch', r => { r.fetchCount = 3; }],
    ['external network', r => { r.runs[0].externalRequests = 1; }], ['missing controlled receipt', r => { r.runs[0].requests = []; }],
    ['wrong logical origin', r => { r.runs[0].requests[0].url = 'https://gateway.example/package.Service/Method'; }],
    ['wrong conversion intent', r => { r.runs[0].fetchIntents[0].grpcWeb = 'passthrough'; }],
    ['payload mismatch', r => { r.runs[0].requests[0].payloadHex = '00'; }], ['missing timeout', r => { r.runs[0].requests[0].timeout = ''; }],
    ['timeout derivation forged', r => { r.runs[0].requests[0].timeout = '500m'; }],
    ['unbounded default timeout', r => { r.runs[0].requests[0].defaultTimeoutMs = 20000; }], ['missing trailer', r => { r.runs[0].requests[0].responseFrames = 1; }],
    ['held peer response', r => { r.runs[0].requests[0].responseReleased = false; }], ['retained request', r => { r.runs[0].diagnostics.requestBytes = 4; }],
    ['timer held', r => { r.runs[0].diagnostics.timerActive = true; }], ['parser held', r => { r.runs[0].execution.parserAssemblies = 1; }],
    ['active call held', r => { r.runs[0].channelActiveCalls = 1; }], ['runtime not disposed', r => { r.runs[0].runtimeDisposed = false; }],
    ['source-built runtime input', r => { r.runs[0].bundleInputs['src/index.ts'] = 'a'.repeat(64); }],
    ['fixture absent from bundle', r => { delete r.runs[0].bundleInputs['fixtures/docs/cloudflare.mjs']; }],
    ['rendered artifact forged', r => { r.generatedArtifacts['verification/doc-examples.md'] = 'b'.repeat(64); }],
  ];
  for (const [name, mutate] of cases) { const report = syntheticReport(); mutate(report); assert.throws(() => validateDocExamplesReport(report), /WGA_DOC_EXAMPLES_INVALID/, name); }
});
test('DOC examples generated inventory visibly distinguishes execution from expectations and binds current source', () => {
  const report = syntheticReport(), rendered = renderExamples(report);
  assert.equal((rendered.match(/\| passed \|/g) || []).length, 2);
  assert.equal((rendered.match(/\| expected \|/g) || []).length, 5);
  assert.ok(rendered.includes('never counted as passed tests'));
  temporary(directory => { copyInventory(directory); assert.throws(() => validateDocExamplesArtifacts(report, directory), /current document inventory/); });
});
