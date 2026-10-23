'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../dist/build/index.cjs');

const missing = '@grpc/grpc-js/missing';
const load = `require(${JSON.stringify(missing)})`;
const pattern = String.raw`/require("@grpc\/grpc-js\/missing")/.test("")`;
const site = { kind: 'require', specifier: missing };
function inspect(t, source) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-statement-asi-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', main: 'index.cjs', dependencies: { 'google-gax': '*' } });
    write('node_modules/sdk/index.cjs', source);
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("DOCTOR_MUST_NOT_EXECUTE_SOURCE");');
    const originalLoad = Module._load;
    Module._load = function (id, ...args) {
        assert.notEqual(id, 'typescript', 'Graph-only inspection keeps the compiler optional');
        return originalLoad.call(this, id, ...args);
    };
    try { return inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }); }
    finally { Module._load = originalLoad; }
}

function check(t, source, expected) {
    const calls = [];
    vm.runInNewContext(source, { require: specifier => { calls.push(specifier); return 2; } }, { timeout: 1000 });
    assert.deepEqual(calls, expected.map(item => item.specifier), 'Native execution validates the loader sites in this fixture');
    assert.deepEqual(literalImports(source), expected);
    const report = inspect(t, source);
    assert.equal(report.passed, expected.length === 0);
    assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports,
        expected.map(item => ({ ...item, file: 'node_modules/sdk/index.cjs', status: 'resolution-failed' })));
}

for (const [name, separator] of [
    ['LF', '\n'], ['CR', '\r'], ['CRLF', '\r\n'], ['LS', '\u2028'], ['PS', '\u2029'],
    ['line comment', ' // boundary\n'], ['multiline comment', ' /* boundary\n */ '],
]) for (const [statement, prefix, suffix] of [
    ['debugger', '', ''],
    ['break', 'do { ', ' } while (false);'],
    ['continue', 'do { ', ' } while (false);'],
    ['break outer', 'outer: do { ', ' } while (false);'],
    ['continue outer', 'outer: do { ', ' } while (false);'],
]) test(`DOCTOR ignores a regex after ${statement} ended by ${name}`, t => {
    check(t, `${prefix}${statement}${separator}${pattern};${suffix}`, []);
});

for (const [name, source] of [
    ['explicit semicolon', `debugger; ${pattern};`],
    ['conditional statement', `if (true) debugger\n${pattern};`],
    ['statement label', `outer: debugger\n${pattern};`],
    ['comment before a jump label', `outer: do { break /* label */ outer\n${pattern}; } while (false);`],
    ['non-ASCII jump label', `외부: do { continue 외부\n${pattern}; } while (false);`],
]) test(`DOCTOR ignores a regex after ${name}`, t => {
    check(t, source, []);
});

for (const statement of ['debugger', 'break', 'continue']) {
    test(`DOCTOR still finds a real loader after ${statement}`, t => {
        const source = statement === 'debugger' ? `debugger\n${load};`
            : `do { ${statement}\n${pattern}; } while (false); ${load};`;
        check(t, source, [site]);
    });
    for (const access of [`.${statement}`, `?.${statement}`]) {
        test(`DOCTOR preserves division after a ${access} property across a newline`, t => {
            check(t, `const api = { ${statement}: 12 }; api${access}\n/ ${load} / 2;`, [site]);
        });
    }
    test(`DOCTOR preserves division after a #${statement} private field across a comment`, t => {
        check(t, `class Value { #${statement} = 12; run() { return this.#${statement} /*\n*/ / ${load} / 2; } } new Value().run();`, [site]);
    });
}

test('DOCTOR finds a loader after the regex following debugger', t => {
    check(t, `debugger\n${pattern}; ${load};`, [site]);
});

for (const statement of ['break', 'continue']) {
    test(`DOCTOR does not consume a label expression after a line break following ${statement}`, () => {
        // The jump makes this code unreachable, but the independent identifier
        // expression still contains a static loader which doctor must inspect.
        const source = `do { ${statement}\nvalue\n/ ${load} / 2; } while (false);`;
        new vm.Script(source);
        assert.deepEqual(literalImports(source), [site]);
    });
}
