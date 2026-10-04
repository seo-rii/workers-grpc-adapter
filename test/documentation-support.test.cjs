'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { deriveSupport, renderSupport, tapOutcomes, assemble, validateDocumentationSupportReport,
  validateDocumentationSupportArtifacts, validateDocumentationInput, sources } = require('../scripts/documentation-support.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const h = 'a'.repeat(64);

// Synthetic profiles, catalogs and receipts are independent of generated
// verification reports. They test derivation and do not certify any runtime.
function profile(id, command) {
  const manifest = { schemaVersion: 1, id, revision: 3, transformerVersion: 1,
    packages: [{ path: 'node_modules/example-sdk', name: 'example-sdk', version: '1.2.3', packageJsonSha256: h }],
    files: [{ path: 'node_modules/example-sdk/runtime.js', sha256: h, transforms: [{ rule: 'synthetic-rule', expectedMatches: 1 }] }],
    schemas: [{ path: 'node_modules/example-sdk/schema.json', sha256: h }], codegenInputs: [],
    loaderOptions: { keepCase: false }, capabilities: ['synthetic-test-only'],
    requiredChecks: ['node --test test/profile-proof.cjs', command] };
  const transformer = { version: 1, sha256: h, typescriptVersion: '5.8.3' };
  const profileSha256 = hash(JSON.stringify(manifest));
  const inputSha256 = hash(JSON.stringify({ packages: manifest.packages.map(pkg => [pkg.path, pkg.packageJsonSha256]),
    sources: [...manifest.files, ...manifest.schemas, ...manifest.codegenInputs].map(file => [file.path, file.sha256]) }));
  const build = { profile: id, revision: manifest.revision, profileSha256, transformer, inputSha256,
    cacheKey: hash(JSON.stringify({ profileSha256, transformer, inputSha256 })), loaderOptions: manifest.loaderOptions,
    loaderOptionsSha256: hash(JSON.stringify(manifest.loaderOptions)), packages: manifest.packages,
    capabilities: manifest.capabilities, requiredChecks: manifest.requiredChecks,
    transformed: [{ path: manifest.files[0].path, rules: [{ rule: 'synthetic-rule', matches: 1 }] }] };
  return { manifest, build, command: id === 'google-static-v1' ? 'workers-sdk' : 'modern-sdk' };
}
function fixture() {
  const catalog = { schemaVersion: 1, cases: [
    ...Array.from({ length: 184 }, (_, index) => ({ id: `API-${String(index + 1).padStart(3, '0')}`, title: `Synthetic requirement ${index + 1}` })),
    ...Array.from({ length: 5 }, (_, index) => ({ id: `DOC-${String(index + 1).padStart(3, '0')}`, title: `Documentation requirement ${index + 1}` })),
  ] };
  const mapping = { schemaVersion: 1, releaseEligible: false, cases: catalog.cases.map((row, index) => ({ id: row.id,
    catalogCaseSha256: hash(JSON.stringify(row)), coverage: index === 0 ? 'covered' : index === 1 ? 'partial' : 'unimplemented',
    reason: 'Synthetic coverage fixture only; not verification evidence.',
    references: index === 0 ? [{ kind: 'tap', source: 'test/catalog-proof.cjs', name: 'catalog proof', command: 'tests' }]
      : index === 1 ? [{ kind: 'json-case', source: 'scripts/controlled-proof.cjs', anchor: 'CONTROLLED_CASES', command: 'controlled',
        report: 'verification/controlled.json', array: '/results', where: { id: 'controlled-case' }, assertions: [{ pointer: '/value', equals: 42 }] }] : [],
    gaps: index === 0 ? [] : ['Unverified remainder is deliberately retained.'] })) };
  const policy = { entries: Array.from({ length: 123 }, (_, index) => ({ name: `Export${index}`, grade: ['S', 'I', 'T', 'U'][index % 4],
    scope: index === 1 ? 'Import-only constructor rejects calls.' : 'Synthetic declared scope.', signatureNotes: 'No runtime certification from this unit fixture.' })) };
  const texts = {
    'compatibility/export-policy.json': json(policy),
    'test/catalog-proof.cjs': "test('catalog proof', () => {});\n",
    'test/profile-proof.cjs': "test('profile proof', () => {});\n",
    'scripts/controlled-proof.cjs': "const CONTROLLED_CASES = ['controlled-case'];\n",
    'scripts/test-workers-auth.cjs': '// Synthetic command source.\n',
    'scripts/test-modern-firestore-recovery.cjs': '// Synthetic command source.\n',
  };
  const reports = { 'verification/controlled.json': { status: 'passed', results: [{ id: 'controlled-case', status: 'passed', value: 42 }] } };
  const commands = ['tests', 'controlled', 'exports-contract', 'workers-sdk', 'modern-sdk', 'workers-auth', 'modern-firestore-recovery'].map(id => ({ id, status: 'passed', exitCode: 0 }));
  const input = { catalog, mapping, policy, commands,
    contract: { status: 'passed', fullNativeExportParity: false, policySha256: hash(texts['compatibility/export-policy.json']), classifications: policy.entries.map(row => ({ ...row, status: 'passed' })) },
    profiles: [profile('google-static-v1', 'node scripts/test-workers-auth.cjs'), profile('google-modern-v1', 'node scripts/test-modern-firestore-recovery.cjs')],
    performance: { status: 'blocked', scope: 'local-controlled-workerd', unsetThresholds: ['sdkImportP50Ms'] },
    tap: 'TAP version 13\nok 1 - catalog proof\nok 2 - profile proof\n1..2\n',
    text(file) { assert.ok(Object.hasOwn(texts, file), `Unknown synthetic source ${file}`); return texts[file]; },
    json(file) { assert.ok(Object.hasOwn(reports, file), `Unknown synthetic report ${file}`); return reports[file]; } };
  return { input, texts, reports };
}
function write(directory, file, bytes) { fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.writeFileSync(path.join(directory, file), bytes); }
function withArtifactFixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doc-support-test-'));
  try {
    const { input, texts, reports } = fixture();
    for (const file of sources) write(directory, file, '// Synthetic source input for artifact validator unit test only.\n');
    for (const [file, text] of Object.entries(texts)) write(directory, file, text);
    for (const [file, report] of Object.entries(reports)) write(directory, file, json(report));
    for (const row of input.profiles) write(directory, `src/build/profiles/${row.manifest.id}.json`, json(row.manifest));
    write(directory, 'compatibility/test-catalog.json', json(input.catalog));
    write(directory, 'compatibility/test-evidence.json', json(input.mapping));
    write(directory, 'compatibility/exports-contract.json', json(input.contract));
    write(directory, 'verification/documentation-input.json', json({ releaseEligible: false, liveGoogleApiExecuted: false, deployedCloudflareExecuted: false, commands: input.commands }));
    write(directory, 'verification/tests.tap', input.tap);
    write(directory, 'verification/workers-sdk-build.json', json(input.profiles[0].build));
    write(directory, 'verification/modern-sdk.json', json({ build: input.profiles[1].build }));
    write(directory, 'verification/sdk-benchmark.json', json({ performanceCertification: input.performance }));
    const result = assemble(directory);
    write(directory, 'verification/documentation-support.md', result.markdown);
    return run(directory, result.report, input);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
test('DOC support preserves coverage, execution, export grade and unset performance policy separately', () => {
  const result = deriveSupport(fixture().input);
  assert.equal(result.cases.length, 184); assert.ok(result.cases.every(row => !row.id.startsWith('DOC-')));
  assert.deepEqual(result.cases.slice(0, 3).map(row => [row.coverage, row.execution, row.satisfiesPlannedCase]), [
    ['covered', 'passed', true], ['partial', 'passed', false], ['planned', 'not_run', false],
  ]);
  assert.equal(result.exports[1].grade, 'I'); assert.equal(result.exports[1].execution, 'passed');
  assert.equal(result.exports[3].grade, 'U'); assert.equal(result.exports[3].execution, 'passed');
  assert.equal(result.performanceCertification.status, 'blocked'); assert.equal(result.releaseEligible, false);
  assert.ok(result.profiles.every(row => row.execution === 'passed'));
  assert.match(renderSupport(result), /partial \| passed \| false/);
  assert.match(renderSupport(result), /planned \| not_run \| false/);
  assert.match(renderSupport(result), /Local threshold policy: \*\*blocked\*\*/);
});
test('DOC support TAP parsing retains failed, skipped, TODO and missing outcomes', () => {
  assert.deepEqual([...tapOutcomes('ok 1 - success\nnot ok 2 - failed\nok 3 - skipped # SKIP disabled\nnot ok 4 - todo # TODO later\nok 5 - escaped \\# title\n')], [
    ['success', 'passed'], ['failed', 'failed'], ['skipped', 'skipped'], ['todo', 'skipped'], ['escaped # title', 'passed'],
  ]);
  assert.throws(() => tapOutcomes('ok 1 - duplicate\nok 2 - duplicate\n'), /duplicate TAP name/);
  for (const [line, expected] of [['not ok 1 - catalog proof\n', 'failed'], ['ok 1 - catalog proof # SKIP optional\n', 'skipped'],
    ['ok 1 - catalog proof # TODO later\n', 'skipped'], ['', 'not_run']]) {
    const { input } = fixture(); input.tap = line + 'ok 2 - profile proof\n';
    const row = deriveSupport(input).cases[0]; assert.equal(row.execution, expected); assert.equal(row.satisfiesPlannedCase, false);
  }
});
test('DOC support blocked, skipped, failed and missing commands or report cases cannot become passed', () => {
  for (const expected of ['blocked', 'skipped', 'failed', 'not_run']) {
    for (const command of ['tests', 'controlled', 'workers-auth', 'modern-sdk', 'exports-contract']) {
      const { input } = fixture();
      if (expected === 'not_run') input.commands = input.commands.filter(row => row.id !== command);
      else { const row = input.commands.find(row => row.id === command); row.status = expected; row.exitCode = 2; }
      const result = deriveSupport(input);
      const actual = command === 'tests' ? result.cases[0].execution : command === 'controlled' ? result.cases[1].execution
        : command === 'workers-auth' ? result.profiles[0].execution : command === 'modern-sdk' ? result.profiles[1].execution : result.exports[0].execution;
      assert.equal(actual, expected, command); assert.equal(result.cases[1].satisfiesPlannedCase, false);
    }
    for (const target of ['report', 'case']) {
      const { input, reports } = fixture();
      (target === 'report' ? reports['verification/controlled.json'] : reports['verification/controlled.json'].results[0]).status = expected;
      assert.equal(deriveSupport(input).cases[1].execution, expected, target);
    }
  }
  const { input } = fixture(); input.tap = 'ok 1 - catalog proof\nnot ok 2 - profile proof # TODO later\n';
  assert.ok(deriveSupport(input).profiles.every(row => row.execution === 'skipped'));
});
test('DOC support rejects raw proof, selector, requirement and execution status drift', () => {
  const mutations = [
    ['missing named test', f => { f.texts['test/catalog-proof.cjs'] = "test('renamed proof', () => {});"; }],
    ['missing report anchor', f => { f.texts['scripts/controlled-proof.cjs'] = 'const changed = true;'; }],
    ['ambiguous selector', f => { f.reports['verification/controlled.json'].results.push({ ...f.reports['verification/controlled.json'].results[0] }); }],
    ['missing selector row', f => { f.reports['verification/controlled.json'].results = []; }],
    ['wrong measured result', f => { f.reports['verification/controlled.json'].results[0].value = 999; }],
    ['unknown case status', f => { f.reports['verification/controlled.json'].results[0].status = 'invented'; }],
    ['unknown report status', f => { f.reports['verification/controlled.json'].status = 'invented'; }],
    ['unknown command status', f => { f.input.commands[0].status = 'invented'; }],
    ['passed nonzero exit', f => { f.input.commands[0].exitCode = 2; }],
    ['duplicate command', f => { f.input.commands.push(f.input.commands[0]); }],
    ['changed requirement', f => { f.input.catalog.cases[0].title = 'Unreviewed requirement'; }],
    ['duplicate coverage', f => { f.input.mapping.cases[1] = f.input.mapping.cases[0]; }],
    ['partial promoted with gaps', f => { f.input.mapping.cases[1].coverage = 'covered'; }],
    ['planned promoted without proof', f => { f.input.mapping.cases[2].coverage = 'covered'; f.input.mapping.cases[2].gaps = []; }],
    ['invented coverage', f => { f.input.mapping.cases[0].coverage = 'certified'; }],
    ['release eligibility', f => { f.input.mapping.releaseEligible = true; }],
  ];
  for (const [name, mutate] of mutations) { const f = fixture(); mutate(f); assert.throws(() => deriveSupport(f.input), /WGA_(?:DOCUMENTATION_SUPPORT|EVIDENCE_INVALID)/, name); }
});
test('DOC support rejects stale exact profiles, required checks and export policy classifications', () => {
  const mutations = [
    ['wrong profile matrix', input => { input.profiles.reverse(); }],
    ['build profile hash', input => { input.profiles[0].build.profileSha256 = h; }],
    ['build revision', input => { input.profiles[0].build.revision++; }],
    ['loader hash', input => { input.profiles[0].build.loaderOptionsSha256 = h; }],
    ['transformer identity', input => { input.profiles[0].build.transformer.sha256 = ''; }],
    ['cache identity', input => { input.profiles[0].build.cacheKey = h; }],
    ['executed transform', input => { input.profiles[0].build.transformed[0].rules[0].matches = 2; }],
    ['missing required test', (input, f) => { f.texts['test/profile-proof.cjs'] = '// No named test'; }],
    ['wrong export scope', input => { input.contract.classifications[0].scope = 'Unsupported promotion'; }],
    ['missing export', input => { input.contract.classifications.pop(); }],
    ['failed export contract', input => { input.contract.status = 'blocked'; }],
    ['export parity claim', input => { input.contract.fullNativeExportParity = true; }],
    ['stale policy hash', input => { input.contract.policySha256 = h; }],
    ['failed export classification', input => { input.contract.classifications[0].status = 'failed'; }],
    ['nonlocal performance scope', input => { input.performance.scope = 'deployed-cloud'; }],
  ];
  for (const [name, mutate] of mutations) { const f = fixture(); mutate(f.input, f); assert.throws(() => deriveSupport(f.input), /WGA_(?:DOCUMENTATION_SUPPORT|EVIDENCE_INVALID)/, name); }
});
test('DOC support aggregate command proofs use immutable receipts without reading the final aggregate', () => {
  function aggregateFixture(status = 'passed') {
    const f = fixture();
    const selected = f.input.commands.find(row => row.id === 'controlled');
    selected.status = status; selected.exitCode = status === 'passed' ? 0 : 2;
    // This deliberately contradictory aggregate is outside the derivation.
    // Any attempt to read it must fail, including when its outer status looks
    // successful or when its stale command claims success for a blocked run.
    f.reports['verification/report.json'] = { status: status === 'passed' ? 'local-gates-passed-cloud-certification-blocked' : 'passed',
      commands: [{ id: 'controlled', status: status === 'passed' ? 'failed' : 'passed', exitCode: status === 'passed' ? 2 : 0 }] };
    const readJson = f.input.json;
    f.input.json = file => { assert.notEqual(file, 'verification/report.json', 'final aggregate creates a self-reference'); return readJson(file); };
    f.input.mapping.cases[1].references[0] = { kind: 'json-case', source: 'scripts/controlled-proof.cjs', anchor: 'CONTROLLED_CASES',
      command: 'tests', report: 'verification/report.json', array: '/commands', where: { id: 'controlled' },
      assertions: [{ pointer: '/status', equals: 'passed' }, { pointer: '/exitCode', equals: 0 }] };
    return f;
  }
  for (const status of ['passed', 'failed', 'blocked', 'skipped', 'not_run']) {
    const { input } = aggregateFixture(status), row = deriveSupport(input).cases[1];
    assert.equal(row.execution, status); assert.equal(row.satisfiesPlannedCase, false);
  }
  for (const pointer of ['/', '/results', '/commands/0', '/cloudCertification']) {
    const { input } = aggregateFixture(); input.mapping.cases[1].references[0].array = pointer;
    assert.throws(() => deriveSupport(input), /aggregate reference requires the command projection/, pointer);
  }
  const missing = aggregateFixture(); missing.input.commands = missing.input.commands.filter(row => row.id !== 'controlled');
  assert.throws(() => deriveSupport(missing.input), /unique report case/, 'stale aggregate cannot supply a missing command');
  const forged = aggregateFixture(); forged.input.commands.find(row => row.id === 'controlled').exitCode = 9;
  assert.throws(() => deriveSupport(forged.input), /executed report assertion/, 'aggregate cannot replace a failed receipt assertion');
});
test('DOC support pre-generation projection exactly joins final receipts and the original source snapshot', () => {
  function projection() {
    const commands = [
      { id: 'tests', status: 'passed', exitCode: 0, log: 'tests.log' },
      { id: 'workers-sdk', status: 'passed', exitCode: 0, log: 'workers-sdk.log' },
      { id: 'google-preflight', status: 'blocked', exitCode: 2, log: 'google-preflight.log' },
    ];
    const evidenceInputHashes = { 'src/index.ts': 'a'.repeat(64), 'test/example.test.cjs': 'b'.repeat(64) };
    const input = { commands: structuredClone(commands), evidenceInputHashes: structuredClone(evidenceInputHashes),
      releaseEligible: false, liveGoogleApiExecuted: false, deployedCloudflareExecuted: false };
    const aggregate = { commands: [...structuredClone(commands), { id: 'documentation-support', status: 'passed', exitCode: 0, log: 'documentation-support.log' }],
      evidenceInputHashes: structuredClone(evidenceInputHashes), releaseEligible: false, liveGoogleApiExecuted: false, deployedCloudflareExecuted: false };
    return { input, aggregate };
  }
  const valid = projection();
  assert.doesNotThrow(() => validateDocumentationInput(valid.input, valid.aggregate));
  const reversedKeys = projection();
  reversedKeys.input.evidenceInputHashes = Object.fromEntries(Object.entries(reversedKeys.input.evidenceInputHashes).reverse());
  assert.doesNotThrow(() => validateDocumentationInput(reversedKeys.input, reversedKeys.aggregate), 'snapshot property order carries no execution meaning');
  const mutations = [
    ['stale command status', f => { f.input.commands[2].status = 'passed'; f.input.commands[2].exitCode = 0; }],
    ['stale command exit', f => { f.input.commands[0].exitCode = 2; }],
    ['stale command log', f => { f.input.commands[0].log = 'another-run.log'; }],
    ['omitted receipt', f => { f.input.commands.splice(1, 1); }],
    ['reordered receipts', f => { f.input.commands.reverse(); }],
    ['invented receipt', f => { f.input.commands.push({ id: 'invented', status: 'passed', exitCode: 0 }); }],
    ['duplicate receipt', f => { f.input.commands.push(structuredClone(f.input.commands[0])); }],
    ['generator included in projection', f => { f.input.commands.push(structuredClone(f.aggregate.commands.at(-1))); }],
    ['missing generator receipt', f => { f.aggregate.commands.pop(); }],
    ['failed generator receipt', f => { f.aggregate.commands.at(-1).status = 'failed'; }],
    ['blocked generator receipt', f => { f.aggregate.commands.at(-1).status = 'blocked'; }],
    ['nonzero generator exit', f => { f.aggregate.commands.at(-1).exitCode = 1; }],
    ['duplicate generator receipt', f => { f.aggregate.commands.push(structuredClone(f.aggregate.commands.at(-1))); }],
    ['nonfinal generator receipt', f => { f.aggregate.commands.unshift(f.aggregate.commands.pop()); }],
    ['changed source snapshot', f => { f.input.evidenceInputHashes['src/index.ts'] = 'c'.repeat(64); }],
    ['omitted source snapshot entry', f => { delete f.input.evidenceInputHashes['src/index.ts']; }],
    ['invented source snapshot entry', f => { f.input.evidenceInputHashes['src/invented.ts'] = 'c'.repeat(64); }],
    ['missing source snapshot', f => { delete f.input.evidenceInputHashes; }],
    ['missing aggregate snapshot', f => { delete f.aggregate.evidenceInputHashes; }],
    ['release eligibility claim', f => { f.input.releaseEligible = true; }],
    ['live Google claim', f => { f.input.liveGoogleApiExecuted = true; }],
    ['deployed Cloudflare claim', f => { f.input.deployedCloudflareExecuted = true; }],
    ['missing local-only flag', f => { delete f.input.liveGoogleApiExecuted; }],
    ['coerced local-only flag', f => { f.input.liveGoogleApiExecuted = 0; }],
    ['aggregate release eligibility claim', f => { f.aggregate.releaseEligible = true; }],
    ['aggregate live Google claim', f => { f.aggregate.liveGoogleApiExecuted = true; }],
    ['aggregate deployed Cloudflare claim', f => { f.aggregate.deployedCloudflareExecuted = true; }],
    ['missing aggregate boundary', f => { delete f.aggregate.deployedCloudflareExecuted; }],
    ['extra projection field', f => { f.input.status = 'passed'; }],
  ];
  for (const [name, mutate] of mutations) {
    const f = projection(); mutate(f);
    assert.throws(() => validateDocumentationInput(f.input, f.aggregate), /WGA_DOCUMENTATION_SUPPORT/, name);
  }
});
test('DOC support artifact validation rejects generated table and raw input tampering', () => {
  withArtifactFixture((directory, report) => assert.doesNotThrow(() => validateDocumentationSupportArtifacts(report, directory)));
  for (const mutate of [
    (directory, report) => { fs.appendFileSync(path.join(directory, 'verification/documentation-support.md'), '\nForged release certification.\n'); },
    (directory, report) => { fs.appendFileSync(path.join(directory, 'test/catalog-proof.cjs'), '// Changed source bytes.\n'); },
    (directory, report) => { const file = path.join(directory, 'verification/controlled.json'); const data = JSON.parse(fs.readFileSync(file)); data.results[0].value = 99; fs.writeFileSync(file, json(data)); },
    (directory, report) => { report.cases[1].coverage = 'covered'; report.cases[1].gaps = []; report.cases[1].satisfiesPlannedCase = true;
      const markdown = renderSupport(report); report.generatedArtifacts['verification/documentation-support.md'] = hash(markdown); write(directory, 'verification/documentation-support.md', markdown); },
    (directory, report) => { report.exports[1].grade = 'S'; const markdown = renderSupport(report); report.generatedArtifacts['verification/documentation-support.md'] = hash(markdown); write(directory, 'verification/documentation-support.md', markdown); },
  ]) withArtifactFixture((directory, report) => { mutate(directory, report); assert.throws(() => validateDocumentationSupportArtifacts(report, directory), /WGA_DOCUMENTATION_SUPPORT/); });
});
test('DOC support report cannot promote partial, planned, blocked or unexecuted cases', () => withArtifactFixture((directory, report) => {
  assert.doesNotThrow(() => validateDocumentationSupportReport(report));
  for (const mutate of [
    r => { r.releaseEligible = true; }, r => { r.liveGoogleApiExecuted = true; }, r => { r.deployedCloudflareExecuted = true; },
    r => { r.fullNativeExportParity = true; }, r => { r.cases[1].satisfiesPlannedCase = true; }, r => { r.cases[2].satisfiesPlannedCase = true; },
    r => { r.cases[0].execution = 'blocked'; }, r => { r.cases[0].execution = 'skipped'; }, r => { r.cases.pop(); },
    r => { r.exports.pop(); }, r => { r.generatedArtifacts['verification/documentation-support.md'] = h; },
  ]) { const changed = structuredClone(report); mutate(changed); assert.throws(() => validateDocumentationSupportReport(changed), /WGA_DOCUMENTATION_SUPPORT/); }
}));
