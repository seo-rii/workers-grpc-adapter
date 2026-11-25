'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { inspectGoogleWorkerGraph } = require('../src/build/index.cjs');

function fixture(t, kind = 'require') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-package-imports-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, contents) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
        return file;
    };
    const entry = `node_modules/sdk/index.${kind === 'import' ? 'mjs' : 'cjs'}`;
    const manifest = imports => write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0',
        main: path.basename(entry), imports, dependencies: { 'google-gax': '*', '@grpc/grpc-js': '*' } });
    const source = specifier => write(entry, kind === 'require' ? `module.exports = require(${JSON.stringify(specifier)});`
        : kind === 'import' ? `import value from ${JSON.stringify(specifier)}; export default value;`
            : `module.exports = import(${JSON.stringify(specifier)}).then(value => value.default);`);
    write('package.json', { name: 'private-import-consumer', private: true });
    manifest({ '#grpc': '@grpc/grpc-js' }); source('#grpc');
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs',
        dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'module.exports = require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0',
        main: 'index.cjs', exports: { '.': './index.cjs' } });
    const marker = path.join(root, 'module-executed');
    write('node_modules/@grpc/grpc-js/index.cjs',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); module.exports = { tag: 'replacement' };`);
    const run = (args, options = {}) => {
        const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000, ...options });
        assert.ifError(result.error);
        return result;
    };
    return { root, write, manifest, source, entry, marker,
        inspect: () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }),
        cli: () => run([path.resolve(__dirname, '../src/build/doctor-cli.cjs'), root, '--sdk=sdk']),
        execute: () => {
            const result = run(['--input-type=module', '--eval', `
                try {
                    const module = await import(${JSON.stringify(pathToFileURL(path.join(root, entry)).href)});
                    const value = await module.default;
                    console.log(JSON.stringify({ tag: value.tag }));
                } catch (error) { console.log(JSON.stringify({ code: error.code })); process.exitCode = 9; }
            `]);
            assert.equal(result.stderr, '');
            return { status: result.status, ...JSON.parse(result.stdout) };
        },
    };
}
const sdk = report => report.results[0].graph.find(item => item.name === 'sdk');
const grpcImports = report => report.results[0].graph.flatMap(item => item.grpcImports);
const packageImports = report => report.results[0].graph.flatMap(item => item.packageImports || []);

for (const kind of ['require', 'import', 'dynamic']) {
    test(`DOCTOR rejects an unavailable gRPC package-import alias through ${kind}`, t => {
        const f = fixture(t, kind);
        f.manifest({ '#grpc': '@grpc/grpc-js/missing' });
        const report = f.inspect(), cli = f.cli();
        assert.equal(report.passed, false);
        assert.equal(cli.status, 2, cli.stderr);
        assert.equal(JSON.parse(cli.stdout).passed, false);
        assert.equal(packageImports(report).find(item => item.specifier === '#grpc').status, 'resolution-failed');
        assert.equal(fs.existsSync(f.marker), false, 'graph inspection does not execute inspected modules');
        assert.deepEqual(f.execute(), { status: 9, code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
        f.source('@grpc/grpc-js/missing');
        assert.equal(f.inspect().passed, false, 'the equivalent direct import is also rejected');
    });

    test(`DOCTOR accepts and identifies the shared adapter through ${kind} package imports`, t => {
        const f = fixture(t, kind), report = f.inspect(), cli = f.cli();
        assert.equal(report.passed, true);
        assert.equal(cli.status, 0, cli.stderr);
        assert.equal(report.identity.status, 'single-installation');
        const imported = sdk(report).grpcImports.find(item => item.specifier === '#grpc');
        assert.equal(imported.implementation, 'workers-grpc-adapter');
        assert.equal(imported.kind, kind === 'require' ? 'require' : 'import');
        assert.equal(imported.resolved, 'node_modules/@grpc/grpc-js/index.cjs');
        assert.equal(fs.existsSync(f.marker), false);
        assert.deepEqual(f.execute(), { status: 0, tag: 'replacement' });
        assert.equal(fs.existsSync(f.marker), true, 'the runtime control really executes the selected target');
    });

    test(`DOCTOR preserves ${kind} conditions when resolving package imports`, t => {
        const f = fixture(t, kind);
        for (const unavailable of ['import', 'require']) {
            f.manifest({ '#grpc': {
                import: '@grpc/grpc-js' + (unavailable === 'import' ? '/missing' : ''),
                require: '@grpc/grpc-js' + (unavailable === 'require' ? '/missing' : ''),
            } });
            const bad = unavailable === (kind === 'require' ? 'require' : 'import');
            assert.equal(f.inspect().passed, !bad, 'only the actual Node condition selects a target');
            assert.deepEqual(f.execute(), bad ? { status: 9, code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }
                : { status: 0, tag: 'replacement' });
        }
    });
}

for (const extension of ['', '.blob']) {
    test(`DOCTOR follows a literal private pattern import to runtime${extension || ' without an extension'}`, t => {
        const f = fixture(t);
        f.manifest({ '#runtime/*': './runtime/*' }); f.source('#runtime/query' + extension);
        f.write('node_modules/sdk/runtime/query' + extension, 'module.exports = require("@grpc/grpc-js/missing");');
        const report = f.inspect();
        assert.equal(report.passed, false);
        assert.equal(grpcImports(report).filter(item => item.specifier === '@grpc/grpc-js/missing').length, 1);
        assert.deepEqual(f.execute(), { status: 9, code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
        f.write('node_modules/sdk/runtime/query' + extension, 'module.exports = require("@grpc/grpc-js");');
        assert.equal(f.inspect().passed, true);
        assert.deepEqual(f.execute(), { status: 0, tag: 'replacement' });
    });
}

test('DOCTOR keeps local JSON package-import targets as data', t => {
    const f = fixture(t);
    f.manifest({ '#data': './data.json' }); f.source('#data');
    f.write('node_modules/sdk/data.json', { tag: 'json-data', example: 'require("@grpc/grpc-js/missing")' });
    const report = f.inspect();
    assert.equal(report.passed, true);
    assert.equal(grpcImports(report).some(item => item.specifier.endsWith('/missing')), false);
    assert.deepEqual(f.execute(), { status: 0, tag: 'json-data' });
});

test('DOCTOR permits an ESM package-import alias to a built-in module', t => {
    const f = fixture(t, 'import');
    f.manifest({ '#fs': 'fs' });
    f.write(f.entry, 'import fs from "#fs"; export default { tag: typeof fs.readFileSync };');
    assert.deepEqual(f.execute(), { status: 0, tag: 'function' });
    assert.equal(f.inspect().passed, true);
});

test('DOCTOR retains a CommonJS package-import resolver failure for a built-in target', t => {
    const f = fixture(t);
    f.manifest({ '#fs': 'fs' }); f.source('#fs');
    // Node 22 resolves this ESM target to node:fs, but its CommonJS loader
    // rejects that non-file URL. Do not substitute ESM resolution for require.
    assert.deepEqual(f.execute(), { status: 9, code: 'ERR_INVALID_URL_SCHEME' });
    assert.equal(f.inspect().passed, false);
});

for (const name of ['@grpc/grpc-js', 'workers-grpc-adapter']) {
    test(`DOCTOR checks the physical ${name} owner reached by a private alias`, t => {
        const f = fixture(t);
        f.manifest({ '#grpc': './linked-runtime' });
        f.write('foreign/package.json', { name, version: '2.0.0' });
        const target = f.write('foreign/runtime.cjs', 'module.exports = { tag: "foreign-runtime" };');
        fs.symlinkSync(target, path.join(f.root, 'node_modules/sdk/linked-runtime'));
        assert.deepEqual(f.execute(), { status: 0, tag: 'foreign-runtime' });
        const report = f.inspect();
        assert.equal(report.passed, false);
        const imported = sdk(report).grpcImports.find(item => item.specifier === '#grpc');
        assert.equal(imported.implementation, name);
        assert.equal(imported.resolved, 'foreign/runtime.cjs');
        if (name === 'workers-grpc-adapter') assert.equal(report.identity.status, 'duplicate-installations');
        else assert.equal(imported.status, 'wrong-implementation');
    });
}

for (const kind of ['require', 'import']) for (const link of ['file', 'directory']) {
    test(`DOCTOR checks an external gRPC alias through a ${link} symlink (${kind})`, t => {
        const f = fixture(t, kind);
        f.manifest({ '#grpc': '@grpc/grpc-js/foreign' });
        f.write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0',
            exports: { '.': './index.cjs', './foreign': './linked/runtime.cjs' } });
        f.write('foreign/package.json', { name: 'unrelated-runtime', version: '2.0.0' });
        const target = f.write('foreign/runtime.cjs', 'module.exports = { tag: "foreign-runtime" };');
        const linked = path.join(f.root, 'node_modules/@grpc/grpc-js/linked');
        if (link === 'file') {
            fs.mkdirSync(linked);
            fs.symlinkSync(target, path.join(linked, 'runtime.cjs'));
        } else fs.symlinkSync(path.dirname(target), linked, 'dir');
        assert.deepEqual(f.execute(), { status: 0, tag: 'foreign-runtime' });
        const report = f.inspect();
        assert.equal(report.passed, false);
        const imported = sdk(report).grpcImports.find(item => item.specifier === '#grpc');
        assert.equal(imported.implementation, 'unrelated-runtime');
        assert.equal(imported.status, 'wrong-implementation');
        f.source('@grpc/grpc-js/foreign');
        assert.equal(f.inspect().passed, false, 'private and direct gRPC imports check the same physical owner');
    });
}

test('DOCTOR checks an external gRPC alias with no physical package owner', t => {
    const f = fixture(t);
    f.write('package.json', { private: true });
    f.manifest({ '#grpc': '@grpc/grpc-js/foreign' });
    f.write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0',
        exports: { '.': './index.cjs', './foreign': './foreign.cjs' } });
    const target = f.write('unowned/runtime.cjs', 'module.exports = { tag: "unowned-runtime" };');
    fs.symlinkSync(target, path.join(f.root, 'node_modules/@grpc/grpc-js/foreign.cjs'));
    assert.deepEqual(f.execute(), { status: 0, tag: 'unowned-runtime' });
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(sdk(report).grpcImports.find(item => item.specifier === '#grpc').status, 'resolution-failed');
});

test('DOCTOR checks the external gRPC package path even when its manifest has another name', t => {
    const f = fixture(t);
    f.write('node_modules/sdk/node_modules/@grpc/grpc-js/package.json', { name: 'unrelated-runtime',
        version: '2.0.0', main: 'index.cjs' });
    f.write('node_modules/sdk/node_modules/@grpc/grpc-js/index.cjs', 'module.exports = { tag: "wrong-package" };');
    assert.deepEqual(f.execute(), { status: 0, tag: 'wrong-package' });
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(sdk(report).grpcImports.find(item => item.specifier === '#grpc').status, 'wrong-implementation');
});

test('DOCTOR keeps an unrelated helper nested inside a gRPC installation separate', t => {
    const f = fixture(t);
    f.write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0',
        main: 'index.cjs', imports: { '#helper': 'helper' }, dependencies: { helper: '*' } });
    f.write('node_modules/@grpc/grpc-js/index.cjs', 'module.exports = require("#helper");');
    f.write('node_modules/@grpc/grpc-js/node_modules/helper/package.json', { name: 'helper', version: '1.0.0', main: 'index.cjs' });
    f.write('node_modules/@grpc/grpc-js/node_modules/helper/index.cjs', 'module.exports = { tag: "helper" };');
    const report = f.inspect();
    assert.equal(report.passed, true);
    assert.equal(grpcImports(report).some(item => item.specifier === '#helper'), false);
    assert.deepEqual(f.execute(), { status: 0, tag: 'helper' });
});

test('DOCTOR ignores shadowed and quoted package-import examples', t => {
    const f = fixture(t);
    f.manifest({});
    f.write(f.entry, `
        function example(require) { return require('#absent'); }
        const object = { require(value) { return value; } };
        object.require('#absent');
        const quoted = 'import "#absent"';
        module.exports = { tag: example(value => value) };
    `);
    const report = f.inspect();
    assert.equal(report.passed, true);
    assert.deepEqual(packageImports(report), []);
    assert.deepEqual(f.execute(), { status: 0, tag: '#absent' });
});

test('DOCTOR resolves private aliases from a createRequire factory base', t => {
    const f = fixture(t, 'import');
    f.write('foreign/package.json', { name: 'foreign-scope', imports: { '#grpc': '@grpc/grpc-js/missing' } });
    f.write(f.entry, `import { createRequire } from 'node:module';
        const require = createRequire(${JSON.stringify(path.join(f.root, 'foreign/loader.cjs'))});
        export default require('#grpc');`);
    assert.deepEqual(f.execute(), { status: 9, code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    assert.equal(f.inspect().passed, false, 'the SDK package map cannot replace the explicit factory base');
});

test('DOCTOR fails closed on a private alias with an unproven createRequire base', t => {
    const f = fixture(t, 'import');
    f.write(f.entry, `import { createRequire } from 'node:module';
        const require = createRequire(getBase()); require('#grpc');`);
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(packageImports(report).find(item => item.specifier === '#grpc').status, 'resolution-base-unverified');
});

test('DOCTOR visits cyclic private runtime imports once per physical file', t => {
    const f = fixture(t);
    f.manifest({ '#runtime/*': './runtime/*' }); f.source('#runtime/first');
    f.write('node_modules/sdk/runtime/first', 'require("#runtime/second"); module.exports = require("@grpc/grpc-js");');
    f.write('node_modules/sdk/runtime/second', 'require("#runtime/first"); require("@grpc/grpc-js/missing");');
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(grpcImports(report).filter(item => item.specifier === '@grpc/grpc-js/missing').length, 1);
    assert.equal(packageImports(report).length, 3);
});

test('DOCTOR re-resolves private package maps after installation changes', t => {
    const f = fixture(t);
    assert.equal(f.inspect().passed, true);
    f.manifest({ '#grpc': '@grpc/grpc-js/missing' });
    assert.equal(f.inspect().passed, false);
    f.manifest({ '#grpc': '@grpc/grpc-js' });
    assert.equal(f.inspect().passed, true);
});
