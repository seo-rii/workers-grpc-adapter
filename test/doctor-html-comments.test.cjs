'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../dist/build/doctor.cjs');

const missing = '@grpc/grpc-js/missing';
const load = `require(${JSON.stringify(missing)});`;
const site = { kind: 'require', specifier: missing };
function fixture(t, source, { file = 'index.cjs', type, nestedType, physicalType } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-html-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const full = path.join(root, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value));
        return full;
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', type, main: file, dependencies: { 'google-gax': '*' } });
    if (nestedType) write('node_modules/sdk/nested/package.json', { type: nestedType });
    const full = physicalType ? write('generated/index.js', source) : write(`node_modules/sdk/${file}`, source);
    if (physicalType) {
        write('generated/package.json', { type: physicalType });
        fs.symlinkSync(full, path.join(root, 'node_modules/sdk', file));
    }
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("DOCTOR_MUST_NOT_EXECUTE_SOURCE");');
    return { full, inspect: () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }) };
}

for (const [name, comment] of [
    ['open', '<!--'], ['open after a value', '1 <!--'], ['close', '-->'],
    ['indented close', ' \t -->'], ['close after block trivia', '/* before */ -->'],
    ['close after multiline trivia', '1; /* before\n */ -->'],
]) test(`DOCTOR ignores Script HTML ${name} comment contents`, () => {
    const source = `${comment} var require = () => {}; ${load}\n${load}`, calls = [];
    vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
    assert.deepEqual(calls, [missing]);
    assert.deepEqual(literalImports(source), [site]);
});

for (const source of [
    `let a=1,b=0; a --> b; ${load}`,
    `let a=1,b=0; a /* same line */ --> b; ${load}`,
    `const text = "<!--"; const pattern = /-->/; ${load}`,
    `const text = \`<!-- \${1} -->\`; ${load}`,
]) test(`DOCTOR retains executable imports around non-comment HTML characters: ${source}`, () => {
    const calls = [];
    vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
    assert.deepEqual(calls, [missing]);
    assert.deepEqual(literalImports(source), [site]);
});

test('DOCTOR distinguishes the Script comment goal from invalid ESM HTML syntax', () => {
    const source = `<!-- ${load}`;
    assert.deepEqual(literalImports(source), []);
    assert.deepEqual(literalImports(source, false, { sourceType: 'module' }), [site]);
    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' });
    assert.equal(syntax.status, 1);
    assert.match(syntax.stderr, /SyntaxError/);
});

for (const options of [
    { file: 'index.cjs' }, { file: 'index.cjs', type: 'module' },
    { file: 'index.js', type: 'commonjs' }, { file: 'index.js' },
    { file: 'nested/index.js', type: 'module', nestedType: 'commonjs' },
    { file: 'index.js', type: 'module', physicalType: 'commonjs' },
]) test(`DOCTOR accepts actual Script HTML comments in ${JSON.stringify(options)}`, t => {
    const f = fixture(t, `<!-- ${load}\nmodule.exports={};`, options);
    const syntax = spawnSync(process.execPath, ['--check', f.full], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.equal(f.inspect().passed, true);
});

for (const options of [
    { file: 'index.mjs' }, { file: 'index.js', type: 'module' },
    { file: 'nested/index.js', type: 'commonjs', nestedType: 'module' },
    { file: 'index.js', type: 'commonjs', physicalType: 'module' },
]) test(`DOCTOR keeps HTML markers out of comment handling for known modules ${JSON.stringify(options)}`, t => {
    const f = fixture(t, `<!-- ${load}`, options);
    const syntax = spawnSync(process.execPath, ['--check', f.full], { encoding: 'utf8' });
    assert.equal(syntax.status, 1);
    assert.equal(f.inspect().passed, false);
});

test('DOCTOR detects the actual missing loader after a fake HTML-comment binding without evaluating the SDK', t => {
    const f = fixture(t, `<!-- var require=()=>{};\n${load}`);
    const executed = spawnSync(process.execPath, [f.full], { encoding: 'utf8' });
    assert.equal(executed.status, 1);
    assert.match(executed.stderr, /MODULE_NOT_FOUND/);
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.deepEqual(report.results[0].graph.find(item => item.name === 'sdk').grpcImports, [{
        ...site, file: 'node_modules/sdk/index.cjs', status: 'resolution-failed',
    }]);
});
