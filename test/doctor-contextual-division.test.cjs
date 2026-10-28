'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');

const missing = '@grpc/grpc-js/missing';
const load = `require(${JSON.stringify(missing)})`;
const site = { kind: 'require', specifier: missing };
const pattern = '/require("@grpc\\/grpc-js\\/regex-only")/';
async function check(source) {
    const calls = [];
    await vm.runInNewContext(source, { require(specifier) { calls.push(specifier); return 3; } }, { timeout: 1000 });
    assert.deepEqual(calls, [missing]);
    assert.deepEqual(literalImports(source), [site]);
}

for (const word of ['of', 'await', 'yield']) {
    for (const scope of ['top-level', 'function', 'arrow', 'method']) {
        test(`DOCTOR scans division after ${word} in a ${scope}`, async () => {
            const body = `const ${word} = 12; ${word} / ${load} / 1;`;
            await check(scope === 'top-level' ? body : scope === 'function' ? `(function () { ${body} })();`
                : scope === 'arrow' ? `(() => { ${body} })();` : `({ run() { ${body} } }).run();`);
        });
    }
    test(`DOCTOR scans division after a free ${word} identifier`, () => check(`globalThis.${word} = 12; ${word} / ${load} / 1;`));
    test(`DOCTOR scans escaped ${word} identifiers`, () => check(`const ${word} = 12; \\u${word.charCodeAt(0).toString(16).padStart(4, '0')}${word.slice(1)} / ${load} / 1;`));
}
for (const word of ['if', 'while', 'for', 'with', 'switch', 'catch']) {
    for (const member of ['.', '?.']) test(`DOCTOR scans division after ${member}${word}()`, () =>
        check(`const obj = { ${word}() { return 12; } }; obj${member}${word}() / ${load} / 1;`));
    test(`DOCTOR scans division after private #${word}()`, () =>
        check(`class C { #${word}() { return 12; } run() { return this.#${word}() / ${load} / 1; } } new C().run();`));
}
for (const [name, source] of [
    ['strict of binding', `'use strict'; const of = 12; of / ${load} / 1;`],
    ['for initializer', `for (let of = 12, value = of / ${load} / 1; false;) {}`],
    ['for condition', `const of = 12; for (; of / ${load} / 1;) break;`],
    ['for-of iterable identifier', `const of = 12; try { for (const value of of / ${load} / 1) {} } catch {}`],
    ['nested function resets await', `async function run() { function inner(await = 12) { return await / ${load} / 1; } return inner(); } run();`],
    ['nested function resets yield', `function* run() { function inner(yield = 12) { return yield / ${load} / 1; } return inner(); } run().next();`],
    ['concise arrow resets await', `const await = 12; async function run() { return (() => await / ${load} / 1)(); } run();`],
    ['concise arrow resets yield', `const yield = 12; function* run() { return (() => yield / ${load} / 1)(); } run().next();`],
    ['class object field index resets await', `const await = 12; async function run() { class C { value = {}\n[await / ${load} / 1]; } return new C(); } run();`],
    ['class arrow field index resets await', `const await = 12; async function run() { class C { value = (() => {})\n[await / ${load} / 1]; } return new C(); } run();`],
    ['class field index resets await', `const await = 12; async function run() { class C { value = [1][await / ${load} / 1]; } return new C(); } run();`],
    ['class field ASI index resets await', `const await = 12; async function run() { class C { value = [1]\n[await / ${load} / 1]; } return new C(); } run();`],
    ['class field resets await', `const await = 12; async function run() { class C { value = await / ${load} / 1; } return new C(); } run();`],
]) test(`DOCTOR preserves contextual identifier division in ${name}`, () => check(source));

for (const [name, source] of [
    ['await in async function', `(async function () { await ${pattern}; ${load}; })();`],
    ['yield in generator', `(function* () { yield ${pattern}; ${load}; })().next().value; ${load};`],
    ['async block arrow', `(async () => { await ${pattern}; ${load}; })();`],
    ['async concise arrow', `(async () => await ${pattern})(); ${load};`],
    ['nested async concise arrow', `(() => async () => await ${pattern})()(); ${load};`],
    ['computed class method', `(async () => { class C { [await ${pattern}]() {} } ${load}; })();`],
    ['computed static class field', `(async () => { class C { static [await ${pattern}] = 1; } ${load}; })();`],
    ['computed class getter', `(async () => { class C { get [await ${pattern}]() { return 1; } } ${load}; })();`],
    ['computed class key after bare field', `(async () => { class C { value\n[await ${pattern}]() {} } ${load}; })();`],
    ['computed class key after quoted field', `(async () => { class C { 'value'\n[await ${pattern}]() {} } ${load}; })();`],
    ['computed class key after computed field', `(async () => { class C { ['value']\n[await ${pattern}]() {} } ${load}; })();`],
    ['computed class key after method', `(async () => { class C { run() {} [await ${pattern}]() {} } ${load}; })();`],
    ['computed class key after static block', `(async () => { class C { static {} [await ${pattern}]() {} } ${load}; })();`],
    ['computed class key in generator', `(function* () { class C { [yield ${pattern}]() {} } })().next(); ${load};`],
    ['computed class key in concise async arrow', `(async () => class { [await ${pattern}]() {} })(); ${load};`],
    ['private async method', `class C { async #run() { await ${pattern}; } run() { return this.#run(); } } new C().run(); ${load};`],
    ['private generator method', `class C { *#run() { yield ${pattern}; } run() { return this.#run().next(); } } new C().run(); ${load};`],
    ['async method after ASI field', `class C { value = 1\nasync run() { await ${pattern}; } } new C().run(); ${load};`],
    ['parenthesized for-of target', `let value; for ((value) of ${pattern}.source) break; ${load};`],
    ['ordinary function in generator', `function* run() { function inner() { const yield = 12; return yield / 2; } yield ${pattern}; } run().next(); ${load};`],
    ['concise arrow followed by comma', `(async () => { const inner = () => 1, result = await ${pattern}; ${load}; })();`],
    ['concise arrow followed by ASI', `(async () => { const inner = () => 1\nawait ${pattern}; ${load}; })();`],
    ['concise arrow in conditional branch', `(async () => { const inner = false ? () => 1 : await ${pattern}; ${load}; })();`],
    ['concise arrow with nested conditional', `(async () => { const inner = () => true ? 1 : 2; await ${pattern}; ${load}; })();`],
    ['async method', `({ async run() { await ${pattern}; ${load}; } }).run();`],
    ['generator method named function', `({ *function() { yield ${pattern}; } }).function().next(); ${load};`],
    ['generator method', `({ *run() { yield ${pattern}; } }).run().next(); ${load};`],
    ['for-of regexp', `for (const value of ${pattern}.source) break; ${load};`],
    ['for-of binding named of', `for (const of of ${pattern}.source) break; ${load};`],
    ['for-await-of regexp', `(async () => { for await (const value of ${pattern}.source) break; ${load}; })();`],
    ['if header', `if (true) ${pattern}.test(''); ${load};`],
    ['while header', `while (false) ${pattern}.test(''); ${load};`],
    ['for header', `for (; false;) ${pattern}.test(''); ${load};`],
    ['with header', `with ({}) ${pattern}.test(''); ${load};`],
]) test(`DOCTOR preserves genuine regexp operands after ${name}`, () => check(source));

test('DOCTOR API and CLI reject missing imports hidden after contextual divisions', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-contextual-division-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
        return file;
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', main: 'index.cjs', dependencies: { 'google-gax': '*' } });
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("DOCTOR_MUST_NOT_EXECUTE_SOURCE");');
    for (const source of [
        `const of = 12; of / ${load} / 1;`,
        `const await = 12; await / ${load} / 1;`,
        `const yield = 12; yield / ${load} / 1;`,
        `const obj = { if() { return 12; } }; obj.if() / ${load} / 1;`,
    ]) {
        const file = write('node_modules/sdk/index.cjs', source);
        const runtime = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 10000 });
        assert.equal(runtime.status, 1);
        assert.match(runtime.stderr, /MODULE_NOT_FOUND/);
        const report = inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] });
        assert.equal(report.passed, false);
        assert.deepEqual(report.results[0].graph.find(item => item.name === 'sdk').grpcImports.map(item => item.status), ['resolution-failed']);
        const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/build/doctor-cli.cjs'), root, '--sdk=sdk'], { encoding: 'utf8', timeout: 10000 });
        assert.equal(cli.status, 2, cli.stderr);
        assert.equal(JSON.parse(cli.stdout).passed, false);
    }
});
