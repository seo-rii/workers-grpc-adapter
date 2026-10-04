'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { checkClaims, validateDocumentationPolicyReport, validateDocumentationPolicyArtifacts } = require('../scripts/documentation-policy.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ids = ['unsupported-root', 'native-readiness', 'tls-options', 'auth-failure', 'logical-peer', 'message-caps'];
const inputs = ['scripts/documentation-policy.cjs', 'compatibility/documentation-policy.json', 'compatibility/export-policy.json',
  'fixtures/worker/package.json', 'fixtures/worker/package-lock.json', 'docs/exports.md', 'docs/claims.md', 'test/synthetic.test.cjs'];
const prefix = 'fixtures/worker/node_modules/@grpc/grpc-js/';
const installed = ['package.json', 'dist/index.js', 'dist/adapter.js', 'dist/call.js', 'dist/credentials.js', 'dist/options.js',
  'dist/config.js', 'dist/wire.js', 'dist/nested/receipt.js'];
// An independently written oracle: these rows are synthetic validator inputs,
// never a receipt from executing the fixture's text or the real policy driver.
const authOracle = [['absent', 2], ['string', 2], ['null', 2], ['object', 2],
  [0, 13], [1, 1], [2, 2], [3, 13], [4, 4], [5, 13], [6, 13], [7, 7], [8, 8],
  [9, 13], [10, 13], [11, 13], [12, 12], [13, 13], [14, 14], [15, 13], [16, 16], [99, 13]];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-synthetic-documentation-policy-'));
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  };
  const text = file => fs.readFileSync(path.join(root, file), 'utf8');
  const entry = (name, grade) => ({ name, grade, scope: 'Synthetic export scope for validator inputs.', signatureNotes: 'Synthetic signature policy; no runtime execution claim.' });
  const policy = { schemaVersion: 1, entries: [entry('SyntheticClient', 'S'), entry('SyntheticServer', 'I'), entry('SyntheticOptions', 'T'),
    ...Array.from({ length: 40 }, (_, index) => entry(`SyntheticAbsent${String(index).padStart(2, '0')}`, 'U'))] };
  write('compatibility/export-policy.json', policy);
  const contract = { status: 'passed', fullNativeExportParity: false, policySha256: hash(text('compatibility/export-policy.json')),
    classifications: policy.entries.map(row => ({ ...row, status: 'passed' })) };
  write('compatibility/exports-contract.json', contract);
  const manifest = { schemaVersion: 1, claims: ids.map(id => ({ id,
    documents: [{ path: 'docs/claims.md', excerpts: [`This synthetic document declares the ${id} boundary explicitly.`] }],
    tests: [{ source: 'test/synthetic.test.cjs', name: `Synthetic boundary proof: ${id}` }] })) };
  write('compatibility/documentation-policy.json', manifest);
  write('docs/claims.md', '# Synthetic reviewed claims\n\n' + manifest.claims.map(row => row.documents[0].excerpts[0]).join('\n\n') + '\n');
  write('docs/exports.md', '# Synthetic export review\n\n| Grade | Description | Count |\n| --- | --- | --- |\n'
    + ['S', 'I', 'T', 'U'].map(grade => `| ${grade} | Synthetic | ${grade === 'U' ? 40 : 1} |`).join('\n')
    + '\n\n## Type-only and absent names\n\n| Native names | '
    + policy.entries.filter(row => row.grade === 'U').map(row => '`' + row.name + '`').join(', ') + ' |\n\n## Explicit package subpaths\n');
  write('test/synthetic.test.cjs', '// Static input only; these functions are never executed.\n'
    + manifest.claims.map(row => `test(${JSON.stringify(row.tests[0].name)}, () => { throw new Error('Do not execute synthetic proof'); });`).join('\n') + '\n');
  write('verification/tests.tap', 'TAP version 13\n' + manifest.claims.map((row, index) => `ok ${index + 1} - ${row.tests[0].name}`).join('\n') + '\n1..6\n');
  write('scripts/documentation-policy.cjs', '// Synthetic source hash receipt; this file must never be executed.\n');
  write('fixtures/worker/package.json', { name: 'synthetic-policy-fixture', private: true });
  write('fixtures/worker/package-lock.json', { name: 'synthetic-policy-fixture', lockfileVersion: 3 });
  for (const file of installed) write(prefix + file, file === 'package.json' ? { name: 'synthetic-installed-alias', version: '0.0.0-synthetic' } : '// Synthetic installed bytes; never executed.\n');
  const tap = new Map(manifest.claims.map(row => [row.tests[0].name, 'passed']));
  const claims = manifest.claims.map(row => ({ id: row.id, status: 'passed',
    documents: [{ path: 'docs/claims.md', sha256: hash(text('docs/claims.md')), excerpts: 1 }],
    tests: row.tests.map(row => ({ ...row, status: 'passed' })) }));
  const report = { schemaVersion: 1, status: 'passed', sourceBuild: false, runtimeExecuted: true, runtime: 'installed-node', liveCloud: false,
    metadataRecorded: false, claims,
    observed: { absent: policy.entries.filter(row => row.grade === 'U').map(row => row.name),
      failures: ['Server', 'ServerCredentials.createSsl', 'ServerCredentials.createInsecure'].map(name => ({ name, code: 'WGA_SERVER_UNSUPPORTED' })),
      tls: ['WGA_UNSUPPORTED_TLS', 'WGA_UNSUPPORTED_TLS', 'WGA_UNSUPPORTED_TLS', 'WGA_UNSUPPORTED_TLS'],
      defaultCaps: { send: 33554432, receive: 33554432 },
      observations: ['cloudflare', 'grpc-web'].map(mode => ({ mode, readiness: [{ code: 12, asynchronous: true }, { code: 12, asynchronous: true }],
        auth: authOracle.map(([inputCode, code]) => ({ inputCode, code, details: 'WGA_AUTH_METADATA', privateDetailsLeaked: false,
          peer: 'https://docs-policy.test:443', authContext: null })),
        sendRejected: { code: 8, bytes: null }, receiveRejected: { code: 8, bytes: null }, recovered: { code: 0, bytes: 1 },
        fetches: 2, resourcesCheckedBeforeClose: true, activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 })) },
    evidence: Object.fromEntries(inputs.map(file => [file, hash(text(file))])),
    resultInputs: Object.fromEntries(['verification/tests.tap', 'compatibility/exports-contract.json'].map(file => [file, hash(text(file))])),
    installedInputs: Object.fromEntries(installed.map(file => [prefix + file, hash(text(prefix + file))])) };
  return { root, write, text, policy, contract, manifest, tap, report,
    check: () => checkClaims(manifest, policy, contract, text, tap), dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function usingFixture(callback) { const value = fixture(); try { return callback(value); } finally { value.dispose(); } }
function rejectedMutation(mutate, pattern = /WGA_DOCUMENTATION_POLICY/) {
  usingFixture(value => { mutate(value); assert.throws(() => value.check(), pattern); });
}

test('DOC policy links six reviewed claims to exhaustive unsupported names, grade counts and named proof tests', () => usingFixture(value => {
  const claims = value.check();
  assert.deepEqual(claims, value.report.claims);
  assert.deepEqual(claims.map(row => row.id), ids);
  assert.equal(validateDocumentationPolicyReport(value.report), value.report);
  assert.equal(validateDocumentationPolicyArtifacts(value.report, value.root), value.report);
}));

test('DOC policy rejects missing or changed excerpts, unsupported names, grades and proof identities', () => {
  for (const mutate of [
    value => value.manifest.claims.pop(), value => value.manifest.claims.reverse(),
    value => { value.manifest.claims[0].documents = []; }, value => { value.manifest.claims[0].tests = []; },
    value => { value.manifest.claims[0].documents[0].excerpts = []; },
    value => { value.manifest.claims[0].documents[0].excerpts = ['too short']; },
    value => value.write('docs/claims.md', value.text('docs/claims.md').replace('unsupported-root boundary', 'altered boundary')),
    value => value.write('docs/exports.md', value.text('docs/exports.md').replace('`SyntheticAbsent00`, ', '')),
    value => value.write('docs/exports.md', value.text('docs/exports.md').replace('`SyntheticAbsent00`', '`SyntheticAbsent01`')),
    value => value.write('docs/exports.md', value.text('docs/exports.md').replace('| U | Synthetic | 40 |', '| U | Synthetic | 39 |')),
    value => value.write('docs/exports.md', value.text('docs/exports.md').replace('## Type-only and absent names', '## Renamed section')),
    value => { value.contract.classifications[0].status = 'not_run'; },
    value => { value.contract.classifications[0].grade = 'U'; },
    value => { value.contract.policySha256 = '0'.repeat(64); },
    value => { value.contract.fullNativeExportParity = true; },
    value => { value.contract.status = 'skipped'; },
    value => { value.manifest.claims[0].tests[0].name = 'Missing synthetic proof'; },
    value => value.write('test/synthetic.test.cjs', "// test('Synthetic boundary proof: unsupported-root', () => {});\n"),
    value => value.tap.set('Synthetic boundary proof: unsupported-root', 'not_run'),
    value => value.tap.set('Synthetic boundary proof: unsupported-root', 'failed'),
    value => value.tap.delete('Synthetic boundary proof: unsupported-root'),
  ]) rejectedMutation(mutate);
});

test('DOC policy receipt rejects authentication leaks, wrong logical peers, altered caps and incomplete cleanup', () => usingFixture(value => {
  const mutations = [
    report => { report.sourceBuild = true; }, report => { report.runtimeExecuted = false; },
    report => { report.liveCloud = true; }, report => { report.metadataRecorded = true; }, report => { report.runtime = 'workerd'; },
    report => report.claims.pop(), report => { report.claims[0].tests[0].status = 'not_run'; },
    report => { report.claims[0].documents[0].sha256 = 'invalid'; },
    report => report.observed.absent.pop(), report => { report.observed.absent[0] = report.observed.absent[1]; },
    report => { report.observed.failures[0].code = 12; }, report => report.observed.tls.pop(),
    report => { report.observed.defaultCaps.send = 4194304; }, report => { report.observed.defaultCaps.receive = -1; },
    report => report.observed.observations.pop(), report => report.observed.observations.reverse(),
  ];
  for (const field of ['activeCalls', 'queuedCalls', 'bufferedBytes']) mutations.push(report => { report.observed.observations[0][field] = 1; });
  for (const mode of [0, 1]) {
    for (const mutation of [
      row => { row.readiness[0].asynchronous = false; }, row => { row.readiness[0].code = 0; },
      row => row.auth.pop(), row => { row.auth[1].code = 16; },
      row => { row.auth[0].privateDetailsLeaked = true; }, row => { row.auth[0].details = 'synthetic private auth detail'; },
      row => { row.auth[0].peer = 'https://docs-gateway.test'; }, row => { row.auth[0].authContext = { certificate: 'synthetic' }; },
      row => { row.sendRejected.code = 0; }, row => { row.receiveRejected.code = 13; }, row => { row.recovered.bytes = 0; },
      row => { row.fetches = 3; }, row => { row.resourcesCheckedBeforeClose = false; },
    ]) mutations.push(report => mutation(report.observed.observations[mode]));
  }
  for (const mutate of mutations) {
    const report = structuredClone(value.report); mutate(report);
    assert.throws(() => validateDocumentationPolicyReport(report), /WGA_DOCUMENTATION_POLICY/);
  }
}));

test('DOC policy artifact validation requires current complete input and installed file inventories', () => {
  for (const mutate of [
    value => value.write('docs/claims.md', value.text('docs/claims.md') + '\nChanged input.\n'),
    value => value.write(prefix + 'dist/wire.js', '// Changed synthetic bytes.\n'),
    value => value.write(prefix + 'dist/added.js', '// An unrecorded installed input.\n'),
    value => { delete value.report.installedInputs[prefix + 'dist/wire.js']; },
    value => { delete value.report.installedInputs[prefix + 'dist/nested/receipt.js']; },
    value => { delete value.report.evidence['docs/claims.md']; },
    value => { delete value.report.resultInputs['verification/tests.tap']; },
    value => { value.report.evidence['extra.cjs'] = hash('// extra\n'); value.write('extra.cjs', '// extra\n'); },
    value => { value.report.observed.absent[0] = 'UnreviewedAbsentName'; },
    value => { value.report.claims[0].documents[0].excerpts = 2; },
    value => { value.report.claims[0].tests[0].name = 'Different named proof'; },
  ]) usingFixture(value => { mutate(value); assert.throws(() => validateDocumentationPolicyArtifacts(value.report, value.root), /WGA_DOCUMENTATION_POLICY/); });
});

test('DOC policy artifact validation rejects skipped TAP and altered policy even when new file hashes are supplied', () => {
  usingFixture(value => {
    const file = 'verification/tests.tap';
    value.write(file, value.text(file).replace('ok 1 - Synthetic boundary proof: unsupported-root', 'ok 1 - Synthetic boundary proof: unsupported-root # SKIP synthetic skipped proof'));
    value.report.resultInputs[file] = hash(value.text(file));
    assert.throws(() => validateDocumentationPolicyArtifacts(value.report, value.root), /proof test not passed/);
  });
  usingFixture(value => {
    value.policy.entries[0].scope = 'Changed synthetic scope which must not match the executed contract.';
    value.write('compatibility/export-policy.json', value.policy);
    value.report.evidence['compatibility/export-policy.json'] = hash(value.text('compatibility/export-policy.json'));
    assert.throws(() => validateDocumentationPolicyArtifacts(value.report, value.root), /executed export policy identity/);
  });
  usingFixture(value => {
    value.write('test/synthetic.test.cjs', '// Only a quoted name remains; no registered test.\n' + JSON.stringify('Synthetic boundary proof: unsupported-root') + ';\n');
    value.report.evidence['test/synthetic.test.cjs'] = hash(value.text('test/synthetic.test.cjs'));
    assert.throws(() => validateDocumentationPolicyArtifacts(value.report, value.root), /named proof test missing/);
  });
});

test('DOC policy artifact paths reject traversal and symlink substitution before reading unrelated files', () => {
  usingFixture(value => {
    value.report.evidence['../outside.cjs'] = '0'.repeat(64);
    assert.throws(() => validateDocumentationPolicyArtifacts(value.report, value.root), /unsafe source path/);
  });
  usingFixture(value => {
    const file = 'docs/claims.md', stored = path.join(value.root, 'replacement.cjs');
    fs.writeFileSync(stored, value.text(file)); fs.unlinkSync(path.join(value.root, file)); fs.symlinkSync(stored, path.join(value.root, file));
    assert.throws(() => validateDocumentationPolicyArtifacts(value.report, value.root), /symlink|symbolic|unsafe source path/);
  });
  usingFixture(value => {
    const directory = path.join(value.root, prefix, 'dist'), replacement = path.join(value.root, 'renamed-dist');
    fs.renameSync(directory, replacement); fs.symlinkSync(replacement, directory, 'dir');
    assert.throws(() => validateDocumentationPolicyArtifacts(value.report, value.root), /symlink|symbolic|unsafe source path/);
  });
});
