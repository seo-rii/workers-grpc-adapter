'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { literalImports } = require('../src/build/imports.cjs');

for (const [specifier, includeLocal] of [['@grpc/grpc-js', false], ['./unrelated.cjs', true]]) {
    test(`DOCTOR ignores non-import path constants before analyzing unrelated bindings: ${specifier}`, () => {
        // Valid generated code can contain many nested functions and path constants
        // without any import site. Those constants must not trigger scope analysis.
        const source = `const path = ${JSON.stringify(specifier)}; const unrelated = ${'() => '.repeat(132)}0;`;
        assert.doesNotThrow(() => new Function(source));
        assert.deepEqual(literalImports(source, false, { includeLocal }), []);
    });
}

const grpc = '@grpc/grpc-js';
for (const [name, source, declaration, options, expected] of [
    ['side-effect import', `import '${grpc}';`, false, {}, [{ kind: 'import', specifier: grpc }]],
    ['named import', `import { Client } from '${grpc}';`, false, {}, [{ kind: 'import', specifier: grpc }]],
    ['re-export', `export * from '${grpc}';`, false, {}, [{ kind: 'import', specifier: grpc }]],
    ['escaped static import', String.raw`import grpc from '\x40grpc/grpc-js';`, false, {}, [{ kind: 'import', specifier: grpc }]],
    ['declaration import', `import type { Client } from '${grpc}';`, true, {}, [{ kind: 'declaration', specifier: grpc }]],
    ['declaration import expression', `type Client = import('${grpc}').Client;`, true, {}, [{ kind: 'declaration', specifier: grpc }]],
    ['parenthesized optional loader', `(require)?.((('${grpc}')));`, false, {}, [{ kind: 'require', specifier: grpc }]],
    ['dynamic import options', `import((('${grpc}')), { with: { type: 'json' } });`, false, {}, [{ kind: 'import', specifier: grpc }]],
    ['literal template import', 'import(`@grpc/grpc-js`);', false, {}, [{ kind: 'import', specifier: grpc }]],
    ['escaped local path', String.raw`require(('\x2e/worker.cjs'));`, false, { includeLocal: true }, [{ kind: 'require', specifier: './worker.cjs' }]],
    ['local re-export', `export * from './worker.cjs';`, false, { includeLocal: true }, [{ kind: 'import', specifier: './worker.cjs' }]],
    ['factory imported from another package', `import { createRequire as make } from 'node:module'; const require = make('/tmp/owner.cjs'); require('${grpc}');`, false, {}, [{ kind: 'require', specifier: grpc, base: { kind: 'literal', value: '/tmp/owner.cjs' } }]],
    ['shadowed loader', `const require = value => value; require('${grpc}');`, false, {}, []],
    ['qualified loader', `object.require('${grpc}');`, false, {}, []],
    ['computed argument', `require('${grpc}' + '/missing');`, false, {}, []],
    ['plain path constant', `const value = '${grpc}'; consume(value);`, false, {}, []],
]) {
    test(`DOCTOR candidate filtering preserves ${name}`, () => {
        assert.deepEqual(literalImports(source, declaration, options), expected);
    });
}

test('DOCTOR retains the scope nesting guard when an actual import site exists', () => {
    const source = `const load = ${'() => '.repeat(132)}require('${grpc}');`;
    assert.doesNotThrow(() => new Function(source));
    assert.throws(() => literalImports(source), /WGA_DOCTOR_SOURCE_NESTING/);
});
