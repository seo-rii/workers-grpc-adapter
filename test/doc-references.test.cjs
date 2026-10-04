'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanDocReferences, validateDocReferencesReport } = require('../scripts/doc-references.cjs');

// This independent miniature repository is synthetic input for the validator.
// It never reads a generated verification report or claims to run its example.
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doc-references-'));
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  };
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const edit = (file, transform) => write(file, transform(read(file)));
  const policy = mutate => { const value = JSON.parse(read('compatibility/doc-references.json')); mutate(value); write('compatibility/doc-references.json', value); };
  write('README.md', '# Synthetic reference fixture\n\n[Guide](docs/guide.md#public-api) and [repeated](docs/guide.md#public-api-1).\n'
    + '[Reference][guide]\n\n[guide]: docs/guide.md#public-api "Guide title"\n\n'
    + '`npm run check`, `npm test`, `node scripts/check.cjs`, `examples/demo.cjs`.\n'
    + 'A diagnostic `WGA_DENIED` and environment `WGA_EXAMPLE_ENV`.\n'
    + 'Cases `API-001/003`, `API-001`–`API-003`, requirement `R-001`, decision `D-001`, SHA-256.\n');
  write('docs/guide.md', '# Guide\n\n## Public API\n\n## Public API\n');
  write('docs/decisions.md', '# Decisions\n\n## D-001: A deliberate contract\n');
  write('docs/spec/v0.3.md', '# Planned design\n\nThese are proposed contracts, not current support.\n');
  write('docs/history.md', '# Historical record\n\n[Current guide](guide.md#public-api).\n');
  write('scripts/check.cjs', "function fail() { throw new Error('WGA_DENIED: synthetic failure'); }\nconst environment = process.env.WGA_EXAMPLE_ENV;\n");
  write('scripts/documentation-sources.cjs', '// Synthetic source receipt, never executed.\n');
  write('src/runtime.ts', 'export const version: number = 1;\n');
  write('test/diagnostic.test.cjs', "const test = require('node:test'); const assert = require('node:assert/strict');\ntest('diagnostic receipt', () => assert.equal(actual, 'WGA_DENIED'));\n");
  write('examples/demo.cjs', "'use strict';\n");
  write('package.json', { name: 'synthetic-doc-reference-fixture', scripts: { check: 'node scripts/check.cjs', test: 'node --test' } });
  write('package-lock.json', { name: 'synthetic-doc-reference-fixture', lockfileVersion: 3, packages: {} });
  write('compatibility/test-catalog.json', { schemaVersion: 1, cases: ['001', '002', '003'].map(number => ({ id: `API-${number}`, requirement_ids: ['R-001'] })) });
  write('compatibility/requirements.json', { schemaVersion: 1, requirements: [{ id: 'R-001' }] });
  write('compatibility/doc-references.json', { schemaVersion: 1, documents: { 'README.md': 'maintained',
    'docs/guide.md': 'maintained', 'docs/decisions.md': 'maintained', 'docs/spec/v0.3.md': 'planned', 'docs/history.md': 'historical' }, exceptions: [] });
  return { root, write, read, edit, policy, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function withRepository(callback) { const fixture = repository(); try { return callback(fixture); } finally { fixture.dispose(); } }
test('DOC references parse CTS and MTS generic consumers as TypeScript and still reject malformed sources', () => {
  for (const extension of ['cts', 'mts']) withRepository(fixture => {
    const file = `src/consumer.${extension}`;
    fixture.write(file, "function identity<T>(value: T): T { return value; }\nconst value = identity<{name: string}>(\n{name: 'fixture'},\n);\nfunction fail() { throw new Error('WGA_MODULE_SOURCE'); }\n");
    fixture.edit('README.md', value => value + '\n`WGA_MODULE_SOURCE`\n');
    const report = scanDocReferences(fixture.root);
    assert.ok(report.evidence[file]);
    fixture.write(file, 'export const value: = 1;\n');
    assert.throws(() => scanDocReferences(fixture.root), /source syntax/);
  });
});
function rejectsMutation(mutate, pattern) {
  withRepository(fixture => { mutate(fixture); assert.throws(() => scanDocReferences(fixture.root), pattern); });
}

test('DOC references inventory resolves local links, commands, diagnostics and explicit identity namespaces', () => withRepository(fixture => {
  const report = scanDocReferences(fixture.root);
  assert.equal(report.status, 'passed'); assert.equal(report.commandsExecuted, false);
  assert.equal(report.externalLinksFetched, false); assert.equal(report.runtimeExecutionEstablished, false);
  assert.equal(report.inventory.documentCount, 5);
  assert.deepEqual(report.inventory.classificationCounts, { maintained: 3, historical: 1, planned: 1 });
  const checks = report.documents.find(row => row.file === 'README.md').checks;
  assert.equal(checks.find(row => row.kind === 'diagnostic').implementation[0].file, 'scripts/check.cjs');
  assert.equal(checks.find(row => row.kind === 'diagnostic').assertionReferences[0].file, 'test/diagnostic.test.cjs');
  assert.equal(checks.find(row => row.kind === 'diagnostic').assertionReferencesAreExecutionEvidence, false);
  assert.deepEqual(checks.find(row => row.kind === 'catalog-range').ids, ['API-001', 'API-002', 'API-003']);
  assert.equal(checks.find(row => row.kind === 'markdown-link').line, 3);
  assert.equal(new Set(checks.map(row => row.id)).size, checks.length);
  assert.equal(validateDocReferencesReport(report, fixture.root), true);
}));

test('DOC references reject missing links, anchors, unsafe escapes and repository traversal', () => {
  for (const [target, pattern] of [
    ['docs/missing.md', /missing repository path/], ['docs/guide.md#missing', /missing anchor/],
    ['docs/guide.md#public-api-2', /missing anchor/], ['docs/%ZZ.md', /malformed percent escape/],
    ['../outside.md', /unsafe repository path/], ['/etc/passwd', /unsupported link/],
    ['docs/%2e%2e/README.md', /encoded traversal/], ['docs/%252e%252e/README.md', /unsafe encoded link/],
    ['docs%5cguide.md', /unsafe encoded link/], ['docs/%00guide.md', /unsafe encoded link/],
    ['%2fREADME.md', /unsafe encoded link/],
    ['javascript:alert(1)', /unsupported link/], ['file:///etc/passwd', /unsupported link/],
  ]) rejectsMutation(fixture => fixture.edit('README.md', value => value + `\n[invalid](${target})\n`), pattern);
  rejectsMutation(fixture => fixture.edit('README.md', value => value + '\n[missing][undefined]\n'), /missing reference link/);
  rejectsMutation(fixture => fixture.edit('README.md', value => value + '\n[guide]: docs/guide.md\n'), /duplicate reference link/);
});

test('DOC references preserve exact line positions and heading anchors across fenced examples', () => withRepository(fixture => {
  fixture.edit('README.md', value => '```text\n[not a document link](missing.md)\n## Public API\n```\n\n' + value);
  fixture.edit('docs/guide.md', value => value + '\n<a id="custom-anchor"></a>\n\n한글 제목\n----------\n');
  fixture.edit('README.md', value => value + '\n[explicit](docs/guide.md#custom-anchor) [unicode](docs/guide.md#한글-제목)\n'
    + '[external](https://example.invalid/not-fetched)\n');
  const report = scanDocReferences(fixture.root), checks = report.documents.find(row => row.file === 'README.md').checks;
  assert.equal(checks.find(row => row.kind === 'markdown-link').line, 8);
  assert.equal(checks.some(row => row.value === 'missing.md'), false);
  assert.equal(checks.filter(row => row.status === 'external-not-fetched').length, 1);
}));

test('DOC references verify npm scripts, Node entry files, multiple test paths and examples', () => {
  for (const [line, pattern] of [
    ['`npm run missing`', /missing npm script/], ['`node scripts/missing.cjs`', /missing repository path/],
    ['`node --test test/diagnostic.test.cjs test/missing.test.cjs`', /missing repository path/],
    ['`node ../outside.cjs`', /unsafe repository path/], ['`node scripts/%2e%2e.cjs`', /invalid Node entry/],
    ['`node --import ../outside.cjs scripts/check.cjs`', /unsafe repository path/],
    ['`node --import=../outside.cjs scripts/check.cjs`', /unsafe repository path/],
    ['`node --require=scripts/%2e%2e.cjs scripts/check.cjs`', /invalid Node preload/],
    ['`examples/missing.cjs`', /missing repository path/], ['`examples/../../outside.cjs`', /unsafe repository path/],
    ['`npm --prefix ../outside run check`', /unsafe repository path/],
    ['`npm run test/../../outside`', /invalid npm script name/],
  ]) rejectsMutation(fixture => fixture.edit('README.md', value => value + `\n${line}\n`), pattern);
  withRepository(fixture => {
    fixture.write('fixtures/npm/package.json', { name: 'synthetic-child', scripts: { child: 'node ../../scripts/check.cjs' } });
    fixture.edit('README.md', value => value + '\n`npm --prefix fixtures/npm run child`\n`node --version`\n`node --test test/diagnostic.test.cjs test/diagnostic.test.cjs`\n');
    const report = scanDocReferences(fixture.root);
    assert.equal(report.inventory.referenceCounts['node-command'], 3);
    assert.ok(report.evidence['fixtures/npm/package.json']);
  });
});

test('DOC references reject orphan diagnostics even when comments, strings or test names quote them', () => {
  for (const source of [
    '// WGA_ORPHAN\n', "const text = 'WGA_ORPHAN';\n", "const unused = { code: 'WGA_ORPHAN' };\n",
    "console.log('WGA_ORPHAN');\n", "documentTheCode('WGA_ORPHAN');\n",
  ]) rejectsMutation(fixture => {
    fixture.edit('README.md', value => value + '\n`WGA_ORPHAN`\n');
    fixture.write('src/orphan.ts', source);
    fixture.edit('test/diagnostic.test.cjs', value => value + "test('WGA_ORPHAN', () => {});\n");
  }, /orphan diagnostic WGA_ORPHAN/);
  rejectsMutation(fixture => fixture.edit('scripts/check.cjs', value => value.replace("throw new Error('WGA_DENIED: synthetic failure')", "throw new Error('REMOVED')")), /orphan diagnostic WGA_DENIED/);
  withRepository(fixture => {
    fixture.edit('test/diagnostic.test.cjs', () => "test('WGA_DENIED', () => {});\n");
    const diagnostic = scanDocReferences(fixture.root).documents[0].checks.find(row => row.kind === 'diagnostic');
    assert.deepEqual(diagnostic.assertionReferences, []);
  });
});

test('DOC references resolve actual finite registry and parameterized environment reads without importing code', () => withRepository(fixture => {
  fixture.write('fixtures/registry.mjs', "export const suites = { example: { project: 'WGA_REGISTRY_PROJECT' } };\n");
  fixture.write('fixtures/bootstrap.mjs', "import { suites } from './registry.mjs';\nexport function build(env, name) { const suite = Object.hasOwn(suites, name) ? suites[name] : undefined; return env[suite.project]; }\n");
  fixture.write('scripts/env.cjs', "function readNumber(name) { return process.env[name]; }\nreadNumber('WGA_NUMBER');\n");
  fixture.edit('README.md', value => value + '\n`WGA_REGISTRY_PROJECT` and `WGA_NUMBER`.\n');
  const report = scanDocReferences(fixture.root), checks = report.documents[0].checks;
  assert.deepEqual(checks.find(row => row.value === 'WGA_REGISTRY_PROJECT').references.map(row => row.kind),
    ['finite-registry-environment-key', 'imported-registry-environment-read']);
  assert.deepEqual(checks.find(row => row.value === 'WGA_NUMBER').references.map(row => row.kind),
    ['literal-forwarded-to-environment-reader', 'parameterized-environment-read']);
  fixture.edit('fixtures/bootstrap.mjs', value => value.replace('env[suite.project]', 'env.other'));
  assert.throws(() => scanDocReferences(fixture.root), /orphan diagnostic WGA_REGISTRY_PROJECT/);
}));

test('DOC references reject unknown test identities, range holes and namespace confusion', () => {
  for (const value of ['API-999', 'API-001/999', 'DOC-999', 'XYZ-001', 'R-999', 'D-999', 'API-003`–`API-001', 'API-001`–`R-001']) {
    rejectsMutation(fixture => fixture.edit('README.md', text => text + `\n\`${value}\`\n`), /unknown catalog|invalid identity range/);
  }
  rejectsMutation(fixture => {
    const catalog = JSON.parse(fixture.read('compatibility/test-catalog.json')); catalog.cases.splice(1, 1); fixture.write('compatibility/test-catalog.json', catalog);
  }, /missing identity within range/);
  rejectsMutation(fixture => {
    const catalog = JSON.parse(fixture.read('compatibility/test-catalog.json')); catalog.cases[0].requirement_ids.push('R-999'); fixture.write('compatibility/test-catalog.json', catalog);
  }, /orphan catalog requirement/);
  rejectsMutation(fixture => {
    const catalog = JSON.parse(fixture.read('compatibility/test-catalog.json')); catalog.cases.push(catalog.cases[0]); fixture.write('compatibility/test-catalog.json', catalog);
  }, /invalid catalog identities/);
});

test('DOC references require every discovered document to be deliberately classified', () => {
  for (const file of ['NEW.md', 'docs/new.md', '.github/new.md', 'fixtures/example/README.md', 'vendor/README.md']) {
    rejectsMutation(fixture => fixture.write(file, '# New unclassified document\n'), /unclassified, missing or renamed documentation/);
  }
  rejectsMutation(fixture => fs.unlinkSync(path.join(fixture.root, 'docs/history.md')), /unclassified, missing or renamed documentation/);
  rejectsMutation(fixture => fixture.policy(policy => { policy.documents['README.md'] = 'skip'; }), /invalid classification/);
  rejectsMutation(fixture => fixture.edit('docs/history.md', value => value + '\n[old missing file](gone.md)\n'), /missing repository path/);
});

test('DOC references require exact contextual exceptions and reject stale or broadened claims', () => {
  function proposal(fixture) {
    fixture.edit('docs/spec/v0.3.md', value => value + '\nPlanned command: `npm run future`.\n');
    fixture.policy(policy => policy.exceptions.push({ file: 'docs/spec/v0.3.md', kind: 'npm-script', value: 'future',
      classification: 'planned', context: 'Planned command: `npm run future`.', reason: 'A historical proposal; this command has not been implemented.' }));
  }
  withRepository(fixture => {
    proposal(fixture); const report = scanDocReferences(fixture.root);
    assert.equal(report.documents.find(row => row.file === 'docs/spec/v0.3.md').checks[0].status, 'declared-planned');
  });
  rejectsMutation(fixture => { proposal(fixture); fixture.edit('docs/spec/v0.3.md', value => value + '\nCurrent command: `npm run future`.\n'); }, /missing npm script/);
  rejectsMutation(fixture => { proposal(fixture); fixture.edit('docs/spec/v0.3.md', value => value.replace('Planned command:', 'Changed context:')); }, /stale exception context/);
  rejectsMutation(fixture => { proposal(fixture); const pkg = JSON.parse(fixture.read('package.json')); pkg.scripts.future = 'node scripts/check.cjs'; fixture.write('package.json', pkg); }, /obsolete npm-script exception/);
  rejectsMutation(fixture => { proposal(fixture); fixture.policy(policy => policy.exceptions.push(policy.exceptions[0])); }, /duplicate exception/);
  rejectsMutation(fixture => { proposal(fixture); fixture.policy(policy => { policy.exceptions[0].context = 'future'; }); }, /missing npm script/);
  rejectsMutation(fixture => {
    const context = 'Planned file: `src/../../outside.ts`.';
    fixture.edit('docs/spec/v0.3.md', value => value + `\n${context}\n`);
    fixture.policy(policy => policy.exceptions.push({ file: 'docs/spec/v0.3.md', kind: 'repository-path', value: 'src/../../outside.ts',
      classification: 'planned', context, reason: 'A proposal must not weaken repository path isolation.' }));
  }, /unsafe planned repository path/);
});

test('DOC references provenance rejects altered receipts and separates generated artifacts from source hashes', () => withRepository(fixture => {
  fixture.write('compatibility/google-graph.json', { synthetic: true, installed: [] });
  fixture.edit('README.md', value => value + '\n`compatibility/google-graph.json`\n');
  const report = scanDocReferences(fixture.root);
  assert.equal(report.evidence['compatibility/google-graph.json'], undefined);
  assert.match(report.artifactInputs['compatibility/google-graph.json'], /^[0-9a-f]{64}$/);
  for (const mutate of [
    value => { value.commandsExecuted = true; }, value => value.documents.pop(),
    value => { value.documents[0].checks[0].status = 'ignored'; }, value => { value.documents[0].classification = 'historical'; },
    value => { value.documents[0].checks[0].line++; }, value => { value.inventory.documentCount--; },
    value => { delete value.evidence['src/runtime.ts']; }, value => { value.artifactInputs['compatibility/google-graph.json'] = '0'.repeat(64); },
  ]) { const altered = structuredClone(report); mutate(altered); assert.throws(() => validateDocReferencesReport(altered, fixture.root), /stale, incomplete or altered/); }
  fixture.edit('src/runtime.ts', value => value + '// Changed input, even without a changed documented name.\n');
  assert.throws(() => validateDocReferencesReport(report, fixture.root), /stale, incomplete or altered/);
}));

test('DOC references reject symlink escapes for both documented targets and scanned source inputs', () => {
  rejectsMutation(fixture => {
    fs.symlinkSync(__filename, path.join(fixture.root, 'outside.cjs'));
    fixture.edit('README.md', value => value + '\n[escape](outside.cjs)\n');
  }, /escapes root/);
  rejectsMutation(fixture => { fs.symlinkSync(__filename, path.join(fixture.root, 'src/linked.cjs')); }, /symbolic source/);
});
