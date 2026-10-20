'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');

function inspect(t, source) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-for-await-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', dependencies: { 'google-gax': '*' } });
    write('node_modules/sdk/index.cjs', source);
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("INSPECTED_MODULE_MUST_NOT_EXECUTE");');
    return inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] });
}

for (const [name, loop] of [
    ['empty statement', 'for await (const require of []);'],
    ['expression statement', 'for await (let require of []) void require;'],
    ['destructured binding', 'for await (const { loader: require } of []) void require;'],
    ['block statement', 'for await (const require of []) {}'],
    ['ordinary for-of control', 'for (const require of []);'],
]) {
    test(`DOCTOR contains for-await bindings within the ${name}`, async t => {
        const source = `(async () => { ${loop} return require("@grpc/grpc-js/missing"); })();`;
        const calls = [];
        await vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
        assert.deepEqual(calls, ['@grpc/grpc-js/missing']);
        assert.deepEqual(literalImports(source), [{ kind: 'require', specifier: '@grpc/grpc-js/missing' }]);
        const report = inspect(t, source);
        assert.equal(report.passed, false);
        assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports.map(item => item.status),
            ['resolution-failed']);
    });
}

for (const [name, loop] of [
    ['expression body', 'for await (const require of [() => 1]) require("@grpc/grpc-js/missing");'],
    ['block body', 'for await (const require of [() => 1]) { require("@grpc/grpc-js/missing"); }'],
    ['destructured body', 'for await (const { loader: require } of [{ loader: () => 1 }]) require("@grpc/grpc-js/missing");'],
    ['function-scoped var control', 'for await (var require of [() => 1]); require("@grpc/grpc-js/missing");'],
]) {
    test(`DOCTOR preserves for-await shadowing in the ${name}`, async t => {
        const source = `(async () => { ${loop} })();`, calls = [];
        await vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
        assert.deepEqual(calls, []);
        assert.deepEqual(literalImports(source), []);
        assert.equal(inspect(t, source).passed, true);
    });
}

test('DOCTOR keeps var bindings in a for-await block in the containing function', async t => {
    const source = '(async () => { for await (const item of [1]) { var require = () => 1; } require("@grpc/grpc-js/missing"); })();';
    const calls = [];
    await vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
    assert.deepEqual(calls, []);
    assert.deepEqual(literalImports(source), []);
    assert.equal(inspect(t, source).passed, true);
});

const localLoad = 'require("@grpc/grpc-js/loop-only")';
for (const [name, body] of [
    ['if/else', `if (false) ${localLoad}; else ${localLoad};`],
    ['block consequent and expression alternate', `if (false) { ${localLoad}; } else ${localLoad};`],
    ['nested dangling else', `if (true) if (false) ${localLoad}; else ${localLoad};`],
    ['nested inner and outer else', `if (false) if (true) ${localLoad}; else ${localLoad}; else ${localLoad};`],
    ['else-if chain', `if (false) ${localLoad}; else if (false) ${localLoad}; else ${localLoad};`],
    ['labeled conditional', `label: if (false) ${localLoad}; else ${localLoad};`],
    ['labeled nested for', `label: for (const item of [1]) if (false) ${localLoad}; else ${localLoad};`],
    ['nested for-await', `for await (const item of [1]) if (false) ${localLoad}; else ${localLoad};`],
    ['nested while', `while (false) if (false) ${localLoad}; else ${localLoad};`],
    ['nested do/while', `do if (false) ${localLoad}; else ${localLoad}; while (false);`],
    ['do/while without a trailing semicolon', `do { ${localLoad}; } while (false)`],
    ['try/catch/finally', `try { ${localLoad}; } catch (error) { ${localLoad}; } finally { ${localLoad}; }`],
    ['switch', `switch (1) { case 1: ${localLoad}; break; default: ${localLoad}; }`],
    ['comma expression', `${localLoad}, ${localLoad};`],
    ['expression with an implicit semicolon', localLoad],
    ['else expression with an implicit semicolon', `if (false) void 0; else ${localLoad}`],
    ['await across a line break', `await\n${localLoad};`],
    ['void across a line break', `void\n${localLoad};`],
    ['call across a line break', 'require\n("@grpc/grpc-js/loop-only");'],
    ['member across a line break', 'void require\n.name;'],
    ['operator across a line break', `${localLoad}\n&& ${localLoad};`],
    ['comma across a line break', `${localLoad}\n, ${localLoad};`],
    ['var across a line break', `var\nvalue = ${localLoad};`],
    ['else member', `require.else(${localLoad});`],
    ['optional else member', `require?.else(${localLoad});`],
    ['await member with an implicit semicolon', 'require.await'],
    ['optional await member with an implicit semicolon', 'require?.await'],
    ['void member with an implicit semicolon', 'require.void'],
]) for (const keyword of ['for await', 'for']) for (const outer of [false, true]) {
    test(`DOCTOR bounds ${keyword} ${name}${outer ? ' before an outer loader' : ''}`, async t => {
        const source = `(async () => { ${keyword} (const require of [Object.assign(() => 1, { else: () => 1 })]) ${body}\n${outer ? 'require("@grpc/grpc-js/missing");' : ''} })();`;
        const calls = [];
        await vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
        assert.deepEqual(calls, outer ? ['@grpc/grpc-js/missing'] : []);
        assert.deepEqual(literalImports(source), outer ? [{ kind: 'require', specifier: '@grpc/grpc-js/missing' }] : []);
        const report = inspect(t, source);
        assert.equal(report.passed, !outer);
        assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports.map(item => item.specifier),
            outer ? ['@grpc/grpc-js/missing'] : []);
    });
}
