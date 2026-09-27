'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const streams = require('node:stream');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const { createGoogleWorkerBuild } = require('../src/build/index.cjs');
const root = path.resolve(__dirname, '..');
const sourcePath = 'node_modules/@google-cloud/firestore/build/src/index.js';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const turn = () => new Promise(resolve => setImmediate(resolve));
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-build-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function loader(preset) {
  let onLoad; preset.plugin.setup({ onLoad(_options, callback) { onLoad = callback; } }); return onLoad;
}
function initialize(source) {
  const ast = ts.createSourceFile('firestore.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const methods = [];
  function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(ast) === '_initializeStream') methods.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.equal(methods.length, 1);
  return vm.runInNewContext(`({${methods[0].getText(ast)}})._initializeStream`, {
    stream_1: streams, logger_1: { logger() {} }, setImmediate,
  });
}
async function eventOrder(method, { listen = true, error = true, earlyError = false } = {}) {
  const backend = new streams.Duplex({ objectMode: true, read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const events = []; let releases = 0;
  const resultPromise = method(backend, { resolve() { releases++; } }, 'local-fixture', listen ? { addTarget: {} } : undefined);
  if (earlyError) {
    backend.emit('error', Object.assign(new Error('controlled'), { code: 7 }));
    backend.destroy();
    await assert.rejects(resultPromise, { code: 7 }); return;
  }
  backend.push({ value: 1 });
  const result = await resultPromise;
  result.on('data', value => events.push(`data:${value.value}`));
  result.on('error', failure => events.push(`error:${failure.code}`));
  result.on('end', () => events.push('end'));
  result.resume(); await turn();
  backend.push(null);
  if (error) backend.emit('error', Object.assign(new Error('controlled'), { code: 7 }));
  await turn(); await turn(); await turn();
  backend.destroy(); result.destroy(); await turn();
  assert.ok(releases > 0, 'SDK stream lifetime is released');
  return events;
}
async function listenLifecycle(t, method, mode) {
  let pendingWrite, result, releases = 0;
  const backend = new streams.Duplex({ objectMode: true, read() {}, write(_chunk, _encoding, callback) {
    if (mode === 'pending-write-error') pendingWrite = callback; else callback();
  } });
  t.after(() => { backend.destroy(); result?.destroy(); });
  const resultPromise = method(backend, { resolve() { releases++; } }, 'local-fixture', { addTarget: {} });
  if (mode === 'pending-write-error') {
    assert.equal(typeof pendingWrite, 'function', 'Listen request is still awaiting its initial write callback');
    backend.emit('error', Object.assign(new Error('controlled'), { code: 7 }));
    await assert.rejects(resultPromise, { code: 7 }, 'an error before Listen becomes healthy rejects initialization');
    backend.destroy(); pendingWrite(); await turn();
    assert.ok(releases > 0, 'failed Listen releases the SDK stream lifetime');
    return;
  }
  result = await resultPromise;
  const events = [];
  result.on('data', () => events.push('data'));
  result.on('error', error => events.push(`error:${error.code}`));
  result.on('end', () => events.push('end'));
  result.resume();
  backend.push(null);
  if (mode === 'destroy-before-deferred-end') result.destroy();
  if (mode === 'unsubscribe-before-deferred-end') result.end();
  await turn(); await turn(); await turn();
  assert.deepEqual(events, mode === 'destroy-before-deferred-end' ? [] : ['end'],
    'Listen finishes once without fabricated data or a spurious stream error');
  assert.ok(releases > 0, 'finished Listen releases the SDK stream lifetime');
}

for (const [fixture, profile, revision] of [['google', 'google-static-v1', 4], ['modern', 'google-modern-v1', 2]]) {
  test(`BUILD ${profile} preserves Listen errors before EOF without changing server streams`, async t => {
    const projectRoot = path.join(root, 'fixtures', fixture), file = path.join(projectRoot, sourcePath);
    const original = fs.readFileSync(file, 'utf8');
    const preset = createGoogleWorkerBuild({ projectRoot, profile, outdir: temporary(t), typescript: ts });
    const transformed = loader(preset)({ path: file });
    assert.ok(transformed, 'pinned Firestore initializer is transformed');
    const raw = initialize(original), patched = initialize(transformed.contents);
    assert.deepEqual(await eventOrder(raw), ['data:1', 'end', 'error:7'], 'raw SDK reproduces the end/error race');
    assert.deepEqual(await eventOrder(patched), ['data:1', 'error:7', 'end']);
    assert.deepEqual(await eventOrder(patched, { error: false }), ['data:1', 'end']);
    assert.deepEqual(await eventOrder(patched, { listen: false }), await eventOrder(raw, { listen: false }));
    await eventOrder(patched, { listen: false, earlyError: true });
    for (const mode of ['empty-eof', 'destroy-before-deferred-end', 'unsubscribe-before-deferred-end', 'pending-write-error']) {
      await t.test(mode, { timeout: 5000 }, t => listenLifecycle(t, patched, mode));
    }
    assert.equal(preset.manifest().revision, revision);
    assert.equal(preset.manifest().transformed[0].firestoreWatchEndDeferrals, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'installed SDK bytes stay unchanged');
  });
}

test('BUILD Watch deferral rejects source drift and changed or duplicate AST anchors', t => {
  const original = fs.readFileSync(path.join(root, 'fixtures/google', sourcePath), 'utf8');
  const build = fs.readFileSync(path.join(root, 'src/build/index.cjs'), 'utf8');
  const fixtures = [
    { name: 'hash', text: original + '\n// changed', hash: digest(original) },
    { name: 'method', text: original.replace('_initializeStream(backendStream, lifetime, requestTag, request)', '_otherStream(backendStream, lifetime, requestTag, request)') },
    { name: 'argument', text: original.replace('backendStream.pipe(resultStream);', 'backendStream.pipe(resultStream, { end: false });') },
    { name: 'receiver', text: original.replace('backendStream.pipe(resultStream);', 'otherStream.pipe(resultStream);') },
    { name: 'target', text: original.replace('backendStream.pipe(resultStream);', 'backendStream.pipe(otherStream);') },
    { name: 'duplicate', text: original.replace('backendStream.pipe(resultStream);', 'backendStream.pipe(resultStream); backendStream.pipe(resultStream);') },
  ];
  const temp = temporary(t);
  for (const fixture of fixtures) {
    const project = path.join(temp, fixture.name), file = path.join(project, sourcePath);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, fixture.text);
    fs.mkdirSync(path.join(project, 'build/profiles'), { recursive: true }); fs.writeFileSync(path.join(project, 'build/index.cjs'), build);
    fs.writeFileSync(path.join(project, 'build/profiles/google-static-v1.json'), JSON.stringify({
      id: 'google-static-v1', revision: 4, packages: [], files: [{ path: sourcePath, sha256: fixture.hash ?? digest(fixture.text) }],
      schemas: [], codegenInputs: [], loaderOptions: {},
    }));
    assert.throws(() => {
      const preset = require(path.join(project, 'build/index.cjs')).createGoogleWorkerBuild({ projectRoot: project, outdir: path.join(project, 'out'), typescript: ts });
      loader(preset)({ path: file });
    }, { code: 'WGA_SCHEMA_MISMATCH' }, fixture.name);
  }
});
