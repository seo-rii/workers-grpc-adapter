'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { readDocumentation, digest } = require('./documentation-sources.cjs');
const sources = ['scripts/documentation-sources.cjs', 'scripts/doc-example-evidence.cjs', 'scripts/test-doc-examples.cjs',
  'compatibility/doc-examples.json', 'fixtures/docs/cloudflare.mjs', 'fixtures/docs/grpc-web.mjs', 'fixtures/docs/worker.mjs',
  'fixtures/worker/package.json', 'fixtures/worker/package-lock.json'];
const selections = [
  { id: 'README.md#fence-5', mode: 'cloudflare', consumer: 'fixtures/docs/cloudflare.mjs' },
  { id: 'README.md#fence-6', mode: 'grpc-web', consumer: 'fixtures/docs/grpc-web.mjs' },
];
const consumerSuffix = '\n// Test harness export; the preceding bytes are the complete README example.\nexport { client };\n';
const prefix = 'fixtures/worker/node_modules/@grpc/grpc-js/';
const checks = ['complete-fence-inventory', 'explicit-unexecuted-classification', 'exact-consumer-source',
  'installed-alias', 'separate-configuration-isolates', 'actual-workerd-rpc', 'mode-routing-and-conversion-intent', 'callback-status-and-cleanup'];
function need(value, message) { if (!value) throw new Error(`WGA_DOC_EXAMPLES_INVALID: ${message}`); }
const equal = (actual, expected, message) => need(isDeepStrictEqual(actual, expected), message);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safe = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => ['', '.', '..'].includes(part));
const keys = value => Object.keys(value || {}).sort();
function timeoutMilliseconds(timeout) {
  const match = typeof timeout === 'string' && /^(\d+)([HMSmun])$/.exec(timeout);
  return match ? Number(match[1]) * { H: 3600000, M: 60000, S: 1000, m: 1, u: .001, n: .000001 }[match[2]] : NaN;
}
function inventoryDocumentation(root, manifest = JSON.parse(fs.readFileSync(path.join(root, 'compatibility/doc-examples.json')))) {
  need(manifest?.schemaVersion === 1 && Array.isArray(manifest.examples), 'manifest schema');
  const docs = readDocumentation(root), blocks = docs.flatMap(doc => doc.blocks);
  equal(manifest.examples.map(row => row.id), blocks.map(block => block.id), 'missing, reordered, or newly unclassified fence');
  const examples = blocks.map((block, index) => {
    const row = manifest.examples[index], selected = selections.find(item => item.id === block.id);
    equal({ file: row.file, ordinal: row.ordinal, language: row.language, sha256: row.sha256 },
      { file: block.file, ordinal: block.ordinal, language: block.language, sha256: block.sha256 }, `stale fence ${block.id}`);
    need(typeof row.reason === 'string' && row.reason.length > 15, `classification reason ${block.id}`);
    if (selected) {
      need(row.classification === 'execute' && row.consumer === selected.consumer && row.category === 'installed-workerd-consumer', `selected example ${block.id}`);
      const consumer = fs.readFileSync(path.join(root, row.consumer), 'utf8');
      equal(consumer, block.content + consumerSuffix, `consumer source mismatch ${block.id}`);
    } else {
      need(row.classification === 'expected' && !Object.hasOwn(row, 'consumer'), `unexecuted example overclaim ${block.id}`);
      need(['historical-specification', 'diagram', 'configuration-fragment', 'shell-command', 'illustrative-code'].includes(row.category), `expected category ${block.id}`);
      if (block.file.startsWith('docs/spec/')) need(row.category === 'historical-specification', `historical example ${block.id}`);
    }
    return { ...row, startLine: block.startLine, endLine: block.endLine };
  });
  need(examples.filter(row => row.classification === 'execute').length === 2, 'exact selected examples');
  return { documents: docs.map(doc => ({ file: doc.file, sha256: doc.sha256, fences: doc.blocks.length })), examples };
}
function renderExamples(report) {
  const lines = ['# Documentation example execution', '',
    'This inventory checks every maintained fenced block. Only the two rows marked `passed` execute here. Expected rows are unexecuted examples, commands, fragments, diagrams, or historical specification; they are never counted as passed tests.', '',
    'Execution scope: installed adapter in local workerd with a controlled gRPC-Web peer. No deployment, edge conversion, live credentials, or Google SDK execution.', '',
    '| Source | Language | Result | Reason |', '| --- | --- | --- | --- |'];
  for (const row of report.examples) lines.push(`| ${row.file}:${row.startLine} (${row.ordinal}) | ${row.language || 'plain'} | ${row.status} | ${row.reason.replaceAll('|', '\\|')} |`);
  return lines.join('\n') + '\n';
}
function validateDocExamplesReport(report) {
  need(report?.schemaVersion === 1 && report.status === 'passed' && report.runtimeExecuted === true && report.workerdExecuted === true, 'completed runtime');
  for (const flag of ['sourceBuild', 'liveCloud', 'liveGoogle', 'realGoogleSDK', 'cloudflareTranslation', 'allExamplesExecuted']) need(report[flag] === false, `${flag} boundary`);
  need(report.controlledPeer === true && report.compatibilityDate === '2026-09-21' && report.runtimeDisposed === true, 'runtime boundary/cleanup');
  need(report.scope === 'Two exact README alternatives in separate local workerd isolates; remaining fenced blocks are expected and unexecuted', 'scope');
  equal(report.checks, checks, 'required checks');
  for (const tool of ['node', 'miniflare', 'workerd', 'esbuild']) need(typeof report[tool] === 'string' && /\d+\.\d+/.test(report[tool]), `${tool} runtime version`);
  need(Array.isArray(report.documents) && report.documents.length > 0 && Array.isArray(report.examples), 'document/block inventory');
  equal(report.documents.map(doc => doc.file), [...new Set(report.documents.map(doc => doc.file))].sort(), 'unique sorted documents');
  for (const doc of report.documents) need(safe(doc.file) && hash(doc.sha256) && Number.isSafeInteger(doc.fences) && doc.fences >= 0
    && doc.fences === report.examples.filter(row => row.file === doc.file).length && report.evidence?.[doc.file] === doc.sha256, 'complete document provenance');
  const ids = report.examples.map(row => row.id); equal(ids, [...new Set(ids)], 'unique example identities');
  for (const row of report.examples) {
    const selected = selections.find(item => item.id === row.id);
    need(report.documents.some(doc => doc.file === row.file) && Number.isSafeInteger(row.ordinal) && row.ordinal > 0
      && row.id === `${row.file}#fence-${row.ordinal}` && hash(row.sha256) && typeof row.language === 'string'
      && Number.isSafeInteger(row.startLine) && row.startLine > 0 && Number.isSafeInteger(row.endLine) && row.endLine > row.startLine
      && typeof row.reason === 'string' && row.reason.length > 15, 'example source identity');
    if (selected) need(row.classification === 'execute' && row.category === 'installed-workerd-consumer' && row.consumer === selected.consumer
      && row.status === 'passed' && row.runtimeExecuted === true, 'executed example receipt');
    else need(row.classification === 'expected' && row.status === 'expected' && row.runtimeExecuted === false
      && !Object.hasOwn(row, 'consumer') && ['historical-specification', 'diagram', 'configuration-fragment', 'shell-command', 'illustrative-code'].includes(row.category), 'unexecuted example cannot pass');
    if (row.file.startsWith('docs/spec/')) need(row.classification === 'expected' && row.category === 'historical-specification', 'historical specification is unexecuted');
  }
  equal(report.counts, { documents: report.documents.length, blocks: report.examples.length, executed: 2, expected: report.examples.length - 2 }, 'inventory counts');
  equal(report.examples.filter(row => row.runtimeExecuted).map(row => row.id), selections.map(row => row.id), 'exact executed rows');
  equal(keys(report.evidence), [...new Set([...sources, ...report.documents.map(doc => doc.file)])].sort(), 'all source/document inputs');
  need(Object.values(report.evidence).every(hash), 'source hashes');
  need(keys(report.installedInputs).length > 2 && keys(report.installedInputs).every(file => safe(file) && file.startsWith('fixtures/worker/node_modules/'))
    && Object.values(report.installedInputs).every(hash), 'installed input hashes');
  for (const file of ['package.json', 'dist/index.mjs', 'dist/config.mjs', 'dist/index.js', 'dist/config.js']) need(hash(report.installedInputs[prefix + file]), 'installed alias entries');
  const installed = report.installedPackage;
  need(installed?.alias === '@grpc/grpc-js' && installed.name === 'workers-grpc-adapter' && typeof installed.version === 'string'
    && installed.path === prefix + 'package.json' && installed.lockfile === 'fixtures/worker/package-lock.json'
    && installed.resolved === `file:../../artifacts/workers-grpc-adapter-${installed.version}.tgz`
    && /^sha512-[A-Za-z0-9+/]{86}==$/.test(installed.integrity) && hash(installed.tarballSha256), 'locked installed alias');
  need(Array.isArray(report.runs) && report.runs.length === 2, 'two fresh runtimes');
  for (const [index, selection] of selections.entries()) {
    const run = report.runs[index], row = report.examples.find(value => value.id === selection.id);
    const origin = selection.mode === 'cloudflare' ? 'https://service.example' : 'https://gateway.example';
    const contentType = selection.mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
    need(run?.id === selection.id && run.mode === selection.mode && run.status === 'passed' && run.freshIsolate === true
      && run.sourceSha256 === row.sha256 && run.consumerSha256 === report.evidence[selection.consumer] && run.sourceMatchesConsumer === true
      && run.runtimeDisposed === true && run.clientClosed === true && run.channelActiveCalls === 0 && run.externalRequests === 0, 'runtime/source/cleanup joins');
    equal(run.callbacks, [{ code: 0, value: '0a026f6b' }], 'actual callback result'); equal(run.statusCodes, [0], 'one terminal status');
    need(run.rpcCount === 1 && run.fetchCount === 1 && run.requests?.length === 1 && run.fetchIntents?.length === 1, 'actual one-Fetch RPC');
    equal(run.fetchIntents[0], { url: origin + '/package.Service/Method', method: 'POST', grpcWeb: selection.mode === 'cloudflare' ? 'convert' : 'passthrough',
      contentType, redirect: 'manual', payloadHex: '00000000040a026f6b' }, 'actual Fetch conversion intent');
    const request = run.requests[0];
    need(request.url === origin + '/package.Service/Method' && request.method === 'POST' && request.contentType === contentType
      && request.accept === contentType && request.grpcWeb === '1' && request.payloadHex === '00000000040a026f6b'
      && request.defaultTimeoutMs === timeoutMilliseconds(request.timeout) && request.defaultTimeoutMs > 0 && request.defaultTimeoutMs <= 10000
      && request.responseFrames === 2 && request.responseReleased === true, 'actual controlled outbound peer');
    equal(run.diagnostics, { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false }, 'transport cleanup');
    equal(run.execution, { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
      parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 }, 'asynchronous owners released');
    need(run.bundlePath === `verification/doc-examples/${selection.mode}.mjs` && hash(run.bundleSha256)
      && run.metafilePath === `verification/doc-examples/${selection.mode}-metafile.json` && hash(run.metafileSha256), 'generated bundle artifacts');
    const inputFiles = keys(run.bundleInputs);
    need(inputFiles.includes(selection.consumer) && inputFiles.includes('fixtures/docs/worker.mjs') && inputFiles.length > 2, 'actual consumer included in bundle');
    for (const file of inputFiles) need(hash(run.bundleInputs[file]) && run.bundleInputs[file] === (report.evidence[file] ?? report.installedInputs[file]), 'bundle input provenance');
    need(inputFiles.filter(file => !file.startsWith('fixtures/worker/node_modules/')).every(file => [selection.consumer, 'fixtures/docs/worker.mjs'].includes(file)), 'no source-build adapter');
  }
  need(report.rpcCount === 2 && report.fetchCount === 2 && report.externalRequests === 0, 'aggregate execution counts');
  equal(report.generatedArtifacts, Object.fromEntries([...report.runs.flatMap(run => [[run.bundlePath, run.bundleSha256], [run.metafilePath, run.metafileSha256]]),
    ['verification/doc-examples.md', digest(renderExamples(report))]]), 'generated artifact manifest');
  return report;
}
function validateDocExamplesArtifacts(report, root) {
  validateDocExamplesReport(report);
  const inventory = inventoryDocumentation(root);
  equal(report.documents, inventory.documents, 'current document inventory');
  equal(report.examples, inventory.examples.map(row => ({ ...row, status: row.classification === 'execute' ? 'passed' : 'expected', runtimeExecuted: row.classification === 'execute' })), 'current fence inventory');
  for (const [file, value] of Object.entries({ ...report.evidence, ...report.installedInputs, ...report.generatedArtifacts })) {
    need(safe(file) && fs.existsSync(path.join(root, file)) && fs.lstatSync(path.join(root, file)).isFile(), `regular input/artifact ${file}`);
    need(digest(fs.readFileSync(path.join(root, file))) === value, `hash drift ${file}`);
  }
  const installed = report.installedPackage;
  const pkg = JSON.parse(fs.readFileSync(path.join(root, installed.path)));
  const lock = JSON.parse(fs.readFileSync(path.join(root, installed.lockfile))).packages['node_modules/@grpc/grpc-js'];
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/worker/package.json')));
  need(pkg.name === installed.name && pkg.version === installed.version && lock.name === installed.name && lock.version === installed.version
    && lock.resolved === installed.resolved && lock.integrity === installed.integrity && fixture.dependencies['@grpc/grpc-js'] === installed.resolved, 'actual package/lock identity');
  const tarball = fs.readFileSync(path.join(root, 'artifacts', `workers-grpc-adapter-${installed.version}.tgz`));
  const crypto = require('node:crypto');
  need(digest(tarball) === installed.tarballSha256 && 'sha512-' + crypto.createHash('sha512').update(tarball).digest('base64') === installed.integrity, 'actual package artifact');
  // Read the known packed archive without extracting any paths. A matching
  // lockfile alone does not establish that the installed runtime was unchanged.
  const archive = require('node:zlib').gunzipSync(tarball, { maxOutputLength: 64 * 1024 * 1024 }), members = new Map();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8);
    need(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= archive.length, 'tar member bounds');
    if ([0, 48].includes(header[156])) members.set(name, archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  for (const [file, value] of Object.entries(report.installedInputs).filter(([file]) => file.startsWith(prefix))) {
    const member = members.get('package/' + file.slice(prefix.length));
    need(member && digest(member) === value, `installed member differs from packed artifact ${file}`);
  }
  for (const run of report.runs) {
    const metafile = JSON.parse(fs.readFileSync(path.join(root, run.metafilePath)));
    equal(keys(metafile.inputs), keys(run.bundleInputs), 'metafile input set');
    for (const [file, input] of Object.entries(metafile.inputs)) need(input.bytes === fs.statSync(path.join(root, file)).size, 'metafile source bytes');
    const outputs = Object.values(metafile.outputs); need(outputs.length === 1 && outputs[0].entryPoint === 'fixtures/docs/worker.mjs'
      && outputs[0].bytes === fs.statSync(path.join(root, run.bundlePath)).size, 'actual Worker bundle output');
  }
  return report;
}
module.exports = { sources, selections, consumerSuffix, checks, inventoryDocumentation, renderExamples, validateDocExamplesReport, validateDocExamplesArtifacts };
