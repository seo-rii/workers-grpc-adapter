'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');

const missing = '@grpc/grpc-js/missing';
const local = '@grpc/grpc-js/branch-local';
const load = `require(${JSON.stringify(missing)})`;
const branch = `function require(name) { return name ? require(${JSON.stringify(local)}) : 'branch'; }`;
const site = { kind: 'require', specifier: missing };
function temporary(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-conditional-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}
function runSource(directory, source, extension = 'cjs') {
    const file = path.join(directory, `control.${extension}`);
    fs.writeFileSync(file, source);
    const expression = extension === 'mjs' ? `import(${JSON.stringify(pathToFileURL(file).href)})`
        : `Promise.resolve().then(() => require(${JSON.stringify(file)}))`;
    const child = spawnSync(process.execPath, ['--eval', `
        ${expression}.then(value => console.log(JSON.stringify({ value })),
            error => console.log(JSON.stringify({ name: error.name, code: error.code, message: error.message, requireStack: error.requireStack })));
    `], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    return { result: JSON.parse(child.stdout), file };
}

const outerLoaderCases = [
    ['false consequent', `if (false) ${branch} module.exports = ${load};`],
    ['true consequent', `if (true) ${branch} module.exports = ${load};`],
    ['fallback guard', `if (typeof require !== 'function') ${branch} module.exports = ${load};`],
    ['false alternate', `if (true) {} else ${branch} module.exports = ${load};`],
    ['true alternate', `if (false) {} else ${branch} module.exports = ${load};`],
    ['both branches', `if (true) ${branch} else ${branch} module.exports = ${load};`],
    ['nested consequent', `if (true) if (false) ${branch} module.exports = ${load};`],
    ['nested dangling else', `if (true) if (false) ${branch} else ${branch} module.exports = ${load};`],
    ['outer alternate', `if (false) if (true) ${branch} else {} else ${branch} module.exports = ${load};`],
    ['braced sloppy control', `if (true) { ${branch} } module.exports = ${load};`],
    ['braced strict control', `'use strict'; if (true) { ${branch} } module.exports = ${load};`],
    ['call named if before a declaration', `const api = { if() {} }; api.if(true)\nfunction ordinary() {} module.exports = ${load};`],
    ...['let', 'const'].flatMap(kind => [false, true].flatMap(condition => ['before', 'after'].map(order => {
        const lexical = `${kind} require = name => 'local:' + name;`;
        const conditional = `if (${condition}) ${branch}`;
        const body = order === 'before' ? `${lexical} ${conditional}` : `${conditional} ${lexical}`;
        return [`intervening ${kind} ${order} a ${condition} branch`, `module.exports = (function() { { ${body} } return ${load}; })();`];
    }))),
    ...[false, true].map(condition => ['destructured catch ' + condition,
        `module.exports = (function() { try { throw {require: () => 'caught'}; } catch ({require}) { if (${condition}) ${branch} } return ${load}; })();`]),
    ['intervening class', `module.exports = (function() { { class require {} if (false) ${branch} } return ${load}; })();`],
    ['intervening loop lexical', `module.exports = (function() { for (let require = () => 'local', once = true; once; once = false) { if (false) ${branch} } return ${load}; })();`],
];
for (const [name, source] of outerLoaderCases) test(`DOCTOR retains the outer CommonJS loader after ${name}`, t => {
    const { result, file } = runSource(temporary(t), source);
    assert.equal(result.code, 'MODULE_NOT_FOUND');
    assert.ok(result.message.includes(missing));
    assert.ok(result.requireStack.includes(file));
    assert.deepEqual(literalImports(source), [site]);
});

for (const [name, source, expected] of [
    ['ordinary top-level function', `function require(name) { return 'local:' + name; } module.exports = ${load};`, { value: `local:${missing}` }],
    ['named function expression', `module.exports = (function require(name) { return name ? require() : 'self'; })(${JSON.stringify(missing)});`, { value: 'self' }],
    ['nested function parameter', `module.exports = (function(require) { if (true) ${branch} return ${load}; })(name => 'parameter:' + name);`, { value: `parameter:${missing}` }],
    ['nested function without a parameter, true branch', `module.exports = (function() { if (true) function require(name) { return 'local:' + name; } return ${load}; })();`, { value: `local:${missing}` }],
    ['nested function without a parameter, false branch', `module.exports = (function() { if (false) ${branch} return ${load}; })();`, { name: 'TypeError' }],
    ['nested function with a lexical binding', `module.exports = (function() { const require = name => 'constant:' + name; if (true) ${branch} return ${load}; })();`, { value: `constant:${missing}` }],
    ['nested function with a var binding', `module.exports = (function() { var require = name => 'variable:' + name; if (false) ${branch} return ${load}; })();`, { value: `variable:${missing}` }],
    ['simple catch parameter, true branch', `module.exports = (function() { try { throw () => 'caught'; } catch (require) { if (true) function require() { return 'local'; } } return ${load}; })();`, { value: 'local' }],
    ['simple catch parameter, false branch', `module.exports = (function() { try { throw () => 'caught'; } catch (require) { if (false) ${branch} } return ${load}; })();`, { name: 'TypeError' }],
]) test(`DOCTOR keeps local loader ownership in a ${name}`, t => {
    const { result } = runSource(temporary(t), source);
    for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value);
    assert.deepEqual(literalImports(source), []);
});

for (const [name, source] of [
    ['factory alias', `import {createRequire as make} from 'node:module'; if (true) { function make() {} } const require = make(import.meta.url); ${load};`],
    ['namespace alias', `import * as tools from 'node:module'; if (true) { function tools() {} } const require = tools.createRequire(import.meta.url); ${load};`],
    ['loader alias', `import {createRequire} from 'node:module'; const require = createRequire(import.meta.url); if (true) { ${branch} } ${load};`],
]) test(`DOCTOR keeps an imported ${name} outside a strict branch`, t => {
    const { result, file } = runSource(temporary(t), source, 'mjs');
    assert.equal(result.code, 'MODULE_NOT_FOUND');
    assert.ok(result.message.includes(missing));
    assert.ok(result.requireStack.includes(file));
    assert.deepEqual(literalImports(source, false, { sourceType: 'module' }), [site]);
});

function fixture(t, source) {
    const projectRoot = temporary(t);
    const write = (name, value) => {
        const file = path.join(projectRoot, name);
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
    return projectRoot;
}
for (const name of ['false consequent', 'true alternate', 'nested dangling else']) {
    test(`DOCTOR API and built CLI fail closed after a ${name}`, t => {
        const source = outerLoaderCases.find(([item]) => item === name)[1];
        const projectRoot = fixture(t, source);
        const report = inspectGoogleWorkerGraph({ projectRoot, sdks: ['sdk'] });
        assert.equal(report.passed, false);
        const imports = report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports;
        assert.deepEqual(imports.map(({ kind, specifier, status }) => ({ kind, specifier, status })), [
            { ...site, status: 'resolution-failed' },
        ]);
        const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/build/doctor-cli.cjs'), projectRoot, '--sdk=sdk'], {
            encoding: 'utf8', timeout: 10000,
        });
        assert.equal(cli.status, 2, cli.stderr);
        assert.equal(JSON.parse(cli.stdout).passed, false);
    });
}

test('DOCTOR still passes a graph with a genuine local require function', t => {
    const source = `function require(name) { return 'local:' + name; } module.exports = ${load};`;
    const projectRoot = fixture(t, source);
    const report = inspectGoogleWorkerGraph({ projectRoot, sdks: ['sdk'] });
    assert.equal(report.passed, true);
    assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports, []);
});
