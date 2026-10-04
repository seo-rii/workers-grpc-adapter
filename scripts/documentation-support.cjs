'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const root = path.resolve(__dirname, '..');
const profileFiles = ['src/build/profiles/google-static-v1.json', 'src/build/profiles/google-modern-v1.json'];
const sources = ['scripts/documentation-support.cjs', 'scripts/test-evidence.cjs', 'compatibility/test-catalog.json',
  'compatibility/test-evidence.json', 'compatibility/export-policy.json', ...profileFiles];
const output = 'verification/documentation-support.md';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function need(value, message) { if (!value) throw new Error(`WGA_DOCUMENTATION_SUPPORT: ${message}`); }
function equal(actual, expected, message) { need(isDeepStrictEqual(actual, expected), message); }
function safe(file) { return typeof file === 'string' && !path.isAbsolute(file) && !file.includes('\\') && file.split('/').every(part => part && part !== '.' && part !== '..'); }
function combine(statuses) { return ['failed', 'blocked', 'skipped', 'not_run', 'passed'].find(status => statuses.includes(status)) || 'not_run'; }
function tapOutcomes(text) {
  const results = new Map();
  for (const line of text.split('\n')) {
    const match = /^(not ok|ok) \d+ - (.*?)(?: #\s*(SKIP|TODO)\b.*)?$/.exec(line);
    if (!match) continue;
    const name = match[2].replace(/\\#/g, '#'); need(!results.has(name), 'duplicate TAP name');
    results.set(name, match[3] ? 'skipped' : match[1] === 'ok' ? 'passed' : 'failed');
  }
  return results;
}
function deriveSupport(input) {
  const { catalog, mapping, commands, policy, contract, profiles, performance, text, json } = input;
  const { namedTests, pointer, validateProfileManifest } = require('./test-evidence.cjs');
  need(catalog.schemaVersion === 1 && mapping.schemaVersion === 1 && mapping.releaseEligible === false, 'catalog scope');
  equal([...new Set(catalog.cases.map(row => row.id))].sort(), catalog.cases.map(row => row.id).sort(), 'unique catalog IDs');
  equal(mapping.cases.map(row => row.id).sort(), catalog.cases.map(row => row.id).sort(), 'complete unique coverage mapping');
  need(Array.isArray(commands) && new Set(commands.map(row => row.id)).size === commands.length, 'unique command receipts');
  function commandStatus(id) {
    const command = commands.find(row => row.id === id);
    if (!command) return 'not_run';
    need(['passed', 'failed', 'blocked', 'skipped', 'not_run'].includes(command.status), 'known execution status');
    if (command.status === 'passed') need(command.exitCode === 0, 'passed command exit code');
    return command.status;
  }
  const tap = tapOutcomes(input.tap);
  const namesByFile = new Map();
  const testNames = file => {
    if (!namesByFile.has(file)) namesByFile.set(file, namedTests(text(file), file));
    return namesByFile.get(file);
  };
  function referenceStatus(ref) {
    const source = text(ref.source), command = commandStatus(ref.command);
    if (ref.kind === 'tap') {
      need(testNames(ref.source).includes(ref.name), 'documented proof test exists');
      return command === 'passed' ? tap.get(ref.name) || 'not_run' : command;
    }
    need(ref.kind === 'json-case' && typeof ref.anchor === 'string' && ref.anchor.length > 3 && source.includes(ref.anchor), 'specific report source anchor');
    if (command !== 'passed') return command;
    // The catalog's aggregate receipt reference addresses only commands. Use
    // the immutable pre-generation command projection instead of hashing the
    // final report that will subsequently embed this generated table.
    if (ref.report === 'verification/report.json') need(ref.array === '/commands', 'aggregate reference requires the command projection');
    const report = ref.report === 'verification/report.json' ? { commands } : json(ref.report);
    need(report.status === undefined || ['passed', 'failed', 'blocked', 'skipped', 'not_run'].includes(report.status), 'known report status');
    if (['failed', 'blocked', 'skipped', 'not_run'].includes(report.status)) return report.status;
    const array = pointer(report, ref.array); need(Array.isArray(array) && Object.keys(ref.where || {}).length, 'specific report selector');
    const found = array.filter(value => Object.entries(ref.where).every(([key, expected]) => isDeepStrictEqual(key === '$value' ? value : value?.[key], expected)));
    need(found.length === 1, 'unique report case');
    const value = found[0];
    if (['failed', 'blocked', 'skipped', 'not_run'].includes(value?.status)) return value.status;
    need(!value?.status || value.status === 'passed', 'known report case status');
    need(ref.assertions?.length, 'report assertions');
    for (const assertion of ref.assertions) equal(pointer(value, assertion.pointer), assertion.equals, 'executed report assertion');
    return 'passed';
  }
  const cases = mapping.cases.filter(row => !row.id.startsWith('DOC-')).map(row => {
    const spec = catalog.cases.find(item => item.id === row.id);
    need(row.catalogCaseSha256 === digest(JSON.stringify(spec)), `${row.id}: reviewed requirement identity`);
    need(['covered', 'partial', 'unimplemented'].includes(row.coverage) && Array.isArray(row.references) && Array.isArray(row.gaps), 'coverage shape');
    need(row.coverage !== 'covered' || row.references.length && row.gaps.length === 0, 'covered case has complete proof');
    need(row.coverage !== 'partial' || row.references.length && row.gaps.length, 'partial case retains gaps');
    need(row.coverage !== 'unimplemented' || row.references.length === 0 && row.gaps.length, 'planned case has no accepted proof');
    const execution = combine(row.references.map(referenceStatus));
    return { id: row.id, title: spec.title, coverage: row.coverage === 'unimplemented' ? 'planned' : row.coverage,
      execution, satisfiesPlannedCase: row.coverage === 'covered' && execution === 'passed', gaps: row.gaps };
  });
  need(contract.status === 'passed' && contract.fullNativeExportParity === false
    && contract.policySha256 === digest(text('compatibility/export-policy.json')), 'executed export policy');
  equal(contract.classifications.map(row => ({ name: row.name, grade: row.grade, scope: row.scope, signatureNotes: row.signatureNotes })), policy.entries, 'all classified export scopes');
  need(contract.classifications.every(row => row.status === 'passed'), 'export classifications passed');
  const scriptGates = { 'scripts/test-google-worker-build.cjs': 'google-worker-build', 'scripts/test-workers-lazy-sdk.cjs': 'workers-lazy-sdk',
    'scripts/test-workers-auth.cjs': 'workers-auth', 'scripts/test-firestore-watch-errors.cjs': 'firestore-watch-errors',
    'scripts/test-modern-sdk.cjs': 'modern-sdk', 'scripts/test-modern-firestore-watch.cjs': 'modern-firestore-watch',
    'scripts/test-modern-firestore-recovery.cjs': 'modern-firestore-recovery' };
  equal(profiles.map(row => row.manifest.id), ['google-static-v1', 'google-modern-v1'], 'exact profile matrix');
  const profileRows = profiles.map(({ manifest, build, command }) => {
    validateProfileManifest(manifest, build);
    const requiredChecks = manifest.requiredChecks.map(check => {
      const words = check.split(' '); let execution;
      need(words[0] === 'node', 'known required-check command');
      if (words[1] === '--test') {
        need(words.length > 2, 'required test sources');
        const names = words.slice(2).flatMap(file => { need(safe(file), 'safe test source'); return testNames(file); });
        need(names.length, 'named required tests');
        execution = commandStatus('tests') === 'passed' ? combine(names.map(name => tap.get(name) || 'not_run')) : commandStatus('tests');
      } else {
        need(words.length === 2 && scriptGates[words[1]], 'reviewed profile required check'); text(words[1]); execution = commandStatus(scriptGates[words[1]]);
      }
      return { command: check, execution };
    });
    return { id: manifest.id, revision: manifest.revision, profileSha256: build.profileSha256,
      execution: combine([commandStatus(command), ...requiredChecks.map(row => row.execution)]),
      packages: manifest.packages, declaredCapabilities: manifest.capabilities, requiredChecks };
  });
  need(['blocked', 'passed', 'failed'].includes(performance.status) && performance.scope === 'local-controlled-workerd', 'local performance policy result');
  return { scope: 'local runtime support; five documentation cases excluded to avoid self-certification', releaseEligible: false,
    liveGoogleApiExecuted: false, deployedCloudflareExecuted: false, fullNativeExportParity: false,
    cases, profiles: profileRows, exports: policy.entries.map(row => ({ ...row, execution: commandStatus('exports-contract') })),
    performanceCertification: performance,
    checks: [{ id: 'runtime-catalog', status: 'passed', cases: cases.length, documentationCasesExcluded: catalog.cases.length - cases.length },
      { id: 'exact-profile-manifests', status: 'passed', profiles: profileRows.length },
      { id: 'complete-export-policy', status: 'passed', exports: policy.entries.length },
      { id: 'nonpassing-status-preservation', status: 'passed', releaseEligible: false }] };
}
function renderSupport(data) {
  const cell = value => String(value).replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ');
  const lines = ['# Generated local compatibility evidence', '', data.scope + '.', '',
    'Coverage and execution are independent. Only covered + passed satisfies a planned case. A passing check of an absent API does not make that API supported.', '',
    'Production release eligibility: false. Live Google and deployed Cloudflare certification: not executed by this local run.', '',
    '## Exact SDK profiles', '', '| Profile | Revision | Local required checks | Manifest SHA-256 |', '| --- | ---: | --- | --- |'];
  for (const row of data.profiles) lines.push(`| ${row.id} | ${row.revision} | ${row.execution} | ${row.profileSha256} |`);
  lines.push('', '| Profile | Package | Installed path | Version | Package manifest SHA-256 |', '| --- | --- | --- | --- | --- |');
  for (const profile of data.profiles) for (const pkg of profile.packages) lines.push(`| ${profile.id} | ${pkg.name} | ${pkg.path} | ${pkg.version} | ${pkg.packageJsonSha256} |`);
  lines.push('', '## Root export grades', '', 'S = supported within stated scope; I = import-only failure; T = type-only; U = absent native name.', '',
    '| Name | Grade | Contract execution | Scope |', '| --- | --- | --- | --- |');
  for (const row of data.exports) lines.push(`| ${row.name} | ${row.grade} | ${row.execution} | ${cell(row.scope)} |`);
  lines.push('', '## Runtime catalog', '', '| Case | Requirement | Coverage | Execution | Satisfies planned case | Remaining gap |', '| --- | --- | --- | --- | --- | --- |');
  for (const row of data.cases) lines.push(`| ${row.id} | ${cell(row.title)} | ${row.coverage} | ${row.execution} | ${row.satisfiesPlannedCase} | ${cell(row.gaps.join(' '))} |`);
  lines.push('', '## Performance certification', '', `Local threshold policy: **${data.performanceCertification.status}**.`, '',
    'Local measurements do not certify deployed latency, live IAM, quotas or long-running reliability.', '');
  return lines.join('\n');
}
function validateDocumentationInput(input, aggregate) {
  need(input && typeof input === 'object' && !Array.isArray(input), 'documentation input object');
  equal(Object.keys(input).sort(), ['commands', 'deployedCloudflareExecuted', 'evidenceInputHashes', 'liveGoogleApiExecuted', 'releaseEligible'], 'exact documentation input fields');
  for (const flag of ['releaseEligible', 'liveGoogleApiExecuted', 'deployedCloudflareExecuted'])
    need(input[flag] === false && aggregate?.[flag] === false, 'local input and aggregate boundary');
  const commands = aggregate?.commands;
  need(Array.isArray(commands) && commands.length > 0, 'aggregate command receipts');
  const generators = commands.filter(row => row.id === 'documentation-support');
  need(generators.length === 1 && generators[0] === commands.at(-1)
    && generators[0].status === 'passed' && generators[0].exitCode === 0, 'one final successful documentation generator');
  equal(input.commands, commands.slice(0, -1), 'exact pre-generation command projection');
  need(aggregate.evidenceInputHashes && Object.keys(aggregate.evidenceInputHashes).length > 0, 'pre-execution source snapshot');
  equal(input.evidenceInputHashes, aggregate.evidenceInputHashes, 'exact pre-execution source snapshot');
  return input;
}
function assemble(base = root) {
  const evidence = {}, resultInputs = {}, cached = new Map();
  function load(file, generated = false) {
    need(safe(file), 'safe input path');
    if (!cached.has(file)) cached.set(file, fs.readFileSync(path.join(base, file)));
    const bytes = cached.get(file);
    (generated ? resultInputs : evidence)[file] = digest(bytes); return bytes.toString();
  }
  const text = file => load(file), json = file => JSON.parse(load(file, true));
  for (const file of sources) text(file);
  const input = json('verification/documentation-input.json');
  need(input.releaseEligible === false && input.liveGoogleApiExecuted === false && input.deployedCloudflareExecuted === false, 'local run boundary');
  const data = deriveSupport({ catalog: JSON.parse(text('compatibility/test-catalog.json')), mapping: JSON.parse(text('compatibility/test-evidence.json')),
    policy: JSON.parse(text('compatibility/export-policy.json')), contract: json('compatibility/exports-contract.json'), commands: input.commands,
    tap: load('verification/tests.tap', true), text, json,
    profiles: profileFiles.map((file, index) => ({ manifest: JSON.parse(text(file)),
      build: index ? json('verification/modern-sdk.json').build : json('verification/workers-sdk-build.json'), command: index ? 'modern-sdk' : 'workers-sdk' })),
    performance: json('verification/sdk-benchmark.json').performanceCertification });
  const markdown = renderSupport(data);
  const report = { schemaVersion: 1, status: 'passed', ...data, evidence, resultInputs, generatedArtifacts: { [output]: digest(markdown) } };
  validateDocumentationSupportReport(report); return { report, markdown };
}
function validateDocumentationSupportReport(report) {
  need(report?.schemaVersion === 1 && report.status === 'passed' && report.releaseEligible === false && report.liveGoogleApiExecuted === false
    && report.deployedCloudflareExecuted === false && report.fullNativeExportParity === false, 'local support scope');
  need(report.cases?.length === 184 && new Set(report.cases.map(row => row.id)).size === 184 && report.cases.every(row => !row.id.startsWith('DOC-')), 'complete runtime case inventory');
  for (const row of report.cases) {
    need(['covered', 'partial', 'planned'].includes(row.coverage) && ['passed', 'failed', 'blocked', 'skipped', 'not_run'].includes(row.execution), 'distinct coverage/execution labels');
    need(row.satisfiesPlannedCase === (row.coverage === 'covered' && row.execution === 'passed'), 'no partial or unexecuted promotion');
  }
  equal(report.profiles.map(row => row.id), ['google-static-v1', 'google-modern-v1'], 'profile identity');
  need(report.exports.length === 123 && new Set(report.exports.map(row => row.name)).size === 123, 'all export grades');
  need(sources.every(file => hash(report.evidence?.[file])) && Object.values(report.resultInputs || {}).length > 2
    && Object.values(report.resultInputs).every(hash), 'support input provenance');
  equal(Object.keys(report.generatedArtifacts), [output], 'generated table path');
  need(report.generatedArtifacts[output] === digest(renderSupport(report)), 'generated table identity');
  return report;
}
function validateDocumentationSupportArtifacts(report, base = root) {
  validateDocumentationSupportReport(report);
  const current = assemble(base); equal(report, current.report, 'current inputs/outcomes exactly reproduce support tables');
  equal(fs.readFileSync(path.join(base, output), 'utf8'), current.markdown, 'generated support table bytes');
  return report;
}
module.exports = { deriveSupport, renderSupport, tapOutcomes, assemble, validateDocumentationInput, validateDocumentationSupportReport, validateDocumentationSupportArtifacts, sources };
if (require.main === module) {
  try {
    const { report, markdown } = assemble(); fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, output), markdown);
    fs.writeFileSync(path.join(root, 'verification/documentation-support.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, cases: report.cases.length, profiles: report.profiles.length, exports: report.exports.length }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
