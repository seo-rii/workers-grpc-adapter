'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reviewExports, compactInventory, checkReviewedSnapshot, reviewConsumerImports } = require('../scripts/export-contract.cjs');
function fixture() {
    const entry = (name, value) => ({ name, type: true, value, sha256: name });
    return { policy: { schemaVersion: 1, upstream: { package: '@grpc/grpc-js', version: '1.14.5' }, extensions: [],
        entries: [['Client', 'S'], ['Server', 'I'], ['Options', 'T'], ['Resolver', 'U']].map(([name, grade]) => ({ name, grade,
            scope: 'Explicitly scoped fixture contract.', signatureNotes: 'Reviewed declaration and behavior differences.' })) },
        upstream: { exports: [entry('Client', true), entry('Server', true), entry('Options', false), entry('Resolver', true)] },
        adapter: { exports: [entry('Client', true), entry('Server', true), entry('Options', false)] },
        upstreamRuntime: ['Client', 'Server', 'Resolver'], adapterRuntime: ['Client', 'Server'], extensions: [] };
}
test('EXPORT contract requires complete reviewed grades and actual runtime/declaration agreement', () => {
    assert.equal(reviewExports(fixture()).length, 4);
    for (const mutate of [
        f => f.policy.entries.pop(), f => f.policy.entries.push(f.policy.entries[0]),
        f => f.policy.entries[0].grade = 'U', f => f.policy.entries[2].grade = 'S',
        f => f.policy.entries[0].grade = 'T', f => f.policy.entries[1].grade = 'unknown',
        f => f.policy.entries[0].signatureNotes = '', f => f.adapterRuntime.push('Options'),
        f => f.upstreamRuntime.pop(), f => f.policy.upstream.version = 'new',
        f => f.extensions.push('./unreviewed'),
    ]) { const value = fixture(); mutate(value); assert.throws(() => reviewExports(value), /WGA_EXPORT_CONTRACT/); }
});
test('EXPORT contract preserves readable dependencies and rejects every unreviewed snapshot change', () => {
    const dependency = { name: 'Options', kind: 'interface', signature: 'interface Options { deadline?: number; }' };
    const input = { compilerVersion: '5.8.3', exports: [
        { name: 'Client', signature: 'class Client {}', dependencies: [dependency] },
        { name: 'Channel', signature: 'class Channel {}', dependencies: [dependency] },
    ], sources: [{ file: 'private.d.ts', sha256: 'a' }] };
    const saved = compactInventory(input);
    assert.equal(Object.keys(saved.declarations).length, 1);
    assert.equal(saved.exports[0].dependencies[0], saved.exports[1].dependencies[0]);
    checkReviewedSnapshot(saved, compactInventory({ ...input, sources: [] }));
    dependency.signature = 'interface Options { deadline: string; }';
    assert.throws(() => checkReviewedSnapshot(saved, compactInventory(input)), /public declarations or consumer imports changed/);
});
test('EXPORT contract distinguishes runtime imports from type-only and unresolved namespace access', () => {
    const { policy } = fixture();
    const input = [{ specifier: '@grpc/grpc-js', kind: 'import', names: ['Client'], runtime: true, namespace: true, dynamicAccess: true },
        { specifier: '@grpc/grpc-js', kind: 'import-type', names: ['Options'], runtime: false, namespace: false, dynamicAccess: false }];
    const result = reviewConsumerImports(input, policy, new Map());
    assert.equal(result[0].dynamicAccess, true, 'a namespace escape must remain explicitly unresolved');
    assert.equal(result[1].reviewedNames[0].grade, 'T');
    for (const bad of [
        { ...input[0], names: ['Options'] }, { ...input[0], names: ['Resolver'] },
        { ...input[0], names: ['Invented'] }, { ...input[0], specifier: '@grpc/grpc-js/private' },
    ]) assert.throws(() => reviewConsumerImports([bad], policy, new Map()), /WGA_EXPORT_CONTRACT/);
});

test('EXPORT contract reports S I T U grades and every native-to-adapter declaration difference', () => {
    const value = fixture();
    value.adapter.exports.find(item => item.name === 'Client').sha256 = 'changed';
    value.adapter.exports.push({ name: 'NewApi', type: false, value: true, sha256: 'added' });
    value.adapterRuntime.push('NewApi');
    value.policy.entries.push({ name: 'NewApi', grade: 'S', scope: 'A documented adapter-only extension.',
        signatureNotes: 'This value does not exist in the native package.' });
    const result = reviewExports(value);
    assert.deepEqual(result.map(({ name, grade, difference }) => ({ name, grade, difference })), [
        { name: 'Client', grade: 'S', difference: 'changed' },
        { name: 'Server', grade: 'I', difference: 'same' },
        { name: 'Options', grade: 'T', difference: 'same' },
        { name: 'Resolver', grade: 'U', difference: 'removed' },
        { name: 'NewApi', grade: 'S', difference: 'added' },
    ]);
    assert.equal(result.find(item => item.name === 'Resolver').adapter, null);
    assert.equal(result.find(item => item.name === 'NewApi').upstream, null);
    for (const grade of ['S', 'I', 'T']) {
        const unavailable = fixture();
        unavailable.policy.entries.find(item => item.name === 'Resolver').grade = grade;
        assert.throws(() => reviewExports(unavailable), /grade disagrees with exported surface/);
    }
    const namespaceOnly = fixture();
    namespaceOnly.adapter.exports.find(item => item.name === 'Options').type = false;
    assert.throws(() => reviewExports(namespaceOnly), /grade disagrees with exported surface/);
});

test('EXPORT contract checks every subpath policy, runtime value and erased declaration', () => {
    const extensionFixture = () => {
        const value = fixture();
        value.extensions = ['./server'];
        value.policy.extensions = [{ entry: './server', scope: 'Fetch handlers are an independent extension.',
            signatureNotes: 'Fetch handlers differ from the unsupported native Server.' }];
        value.subpaths = new Map([['./server', { exports: [
            { name: 'createHandler', type: false, value: true }, { name: 'HandlerOptions', type: true, value: false },
        ] }]]);
        value.subpathRuntime = new Map([['./server', ['createHandler']]]);
        return value;
    };
    assert.equal(reviewExports(extensionFixture()).length, 4);
    for (const mutate of [
        value => value.policy.extensions = [],
        value => value.policy.extensions.push(value.policy.extensions[0]),
        value => value.policy.extensions[0].signatureNotes = '',
        value => value.subpaths.clear(),
        value => value.subpathRuntime.clear(),
        value => value.subpaths.set('./unreviewed', { exports: [] }),
        value => value.subpathRuntime.set('./unreviewed', []),
        value => value.subpathRuntime.get('./server').push('HandlerOptions'),
        value => value.subpathRuntime.get('./server').pop(),
        value => value.subpathRuntime.get('./server').push('extraRuntime'),
    ]) {
        const value = extensionFixture();
        mutate(value);
        assert.throws(() => reviewExports(value), /WGA_EXPORT_CONTRACT/);
    }
});

test('EXPORT contract snapshots are independent deterministic values with deduplicated dependency signatures', () => {
    const first = { name: 'A', kind: 'InterfaceDeclaration', signature: 'interface A { value: number; }' };
    const second = { name: 'B', kind: 'TypeAliasDeclaration', signature: 'type B = string;' };
    const input = { compilerVersion: '5.8.3', exports: [
        { name: 'Z', signature: 'type Z = A & B;', dependencies: [first, second] },
        { name: 'A', signature: 'type A = B;', dependencies: [second] },
    ], sources: [{ file: 'source.d.ts', sha256: 'private-source' }] };
    const saved = compactInventory(input);
    const reversed = { ...input, exports: [...input.exports].reverse().map(value => ({ ...value, dependencies: [...value.dependencies].reverse() })) };
    assert.equal(JSON.stringify(saved), JSON.stringify(compactInventory(reversed)));
    assert.deepEqual(saved.exports.map(value => value.name), ['A', 'Z']);
    assert.equal(Object.keys(saved.declarations).length, 2);
    const copy = structuredClone(saved);
    first.signature = 'interface A { value: boolean; }';
    input.exports[0].signature = 'type Z = never;';
    checkReviewedSnapshot(saved, copy);
    assert.throws(() => checkReviewedSnapshot(saved, compactInventory(input)), /public declarations or consumer imports changed/);
    for (const mutate of [
        value => value.compilerVersion = 'different',
        value => value.exports[0].signature = 'changed',
        value => value.exports[0].dependencies.pop(),
        value => value.exports.push({ name: 'Added' }),
        value => delete value.declarations[Object.keys(value.declarations)[0]],
    ]) {
        const changed = structuredClone(saved);
        mutate(changed);
        assert.throws(() => checkReviewedSnapshot(saved, changed), /public declarations or consumer imports changed/);
    }
});

test('EXPORT contract validates subpath consumer imports and retains import-only client alias grades', () => {
    const { policy } = fixture();
    const client = { exports: [{ name: 'Client', value: true, type: true }, { name: 'Server', value: true, type: true },
        { name: 'Options', value: false, type: true }, { name: 'clientHelper', value: true, type: false }] };
    const subpaths = new Map([['./build/src/client', client], ['./build/src/client.js', client]]);
    for (const suffix of ['build/src/client', 'build/src/client.js']) {
        const record = { specifier: `@grpc/grpc-js/${suffix}`, names: ['Client', 'Server', 'clientHelper'], runtime: true };
        assert.deepEqual(reviewConsumerImports([record], policy, subpaths)[0].reviewedNames, [
            { name: 'Client', grade: 'S' }, { name: 'Server', grade: 'I' }, { name: 'clientHelper', grade: 'S' },
        ]);
        assert.deepEqual(reviewConsumerImports([{ ...record, names: ['Options'], runtime: false }], policy, subpaths)[0].reviewedNames,
            [{ name: 'Options', grade: 'T' }]);
        for (const name of ['Options', 'Missing']) {
            assert.throws(() => reviewConsumerImports([{ ...record, names: [name] }], policy, subpaths), /WGA_EXPORT_CONTRACT/);
        }
    }
    for (const declaration of [
        { name: 'Options', value: true, type: true },
        { name: 'Client', value: false, type: true },
        { name: 'Resolver', value: true, type: true },
    ]) {
        const mismatched = new Map([['./build/src/client', { exports: [declaration] }]]);
        assert.throws(() => reviewConsumerImports([{ specifier: '@grpc/grpc-js/build/src/client', names: [declaration.name], runtime: false }],
            policy, mismatched), /client alias disagrees with root grade/);
    }
    assert.deepEqual(reviewConsumerImports([{ specifier: '@grpc/grpc-js/package.json', names: ['version'], runtime: true }], policy, subpaths)[0].reviewedNames,
        [{ name: 'version', grade: 'metadata' }]);
    assert.throws(() => reviewConsumerImports([{ specifier: 'unrelated-package', names: [], runtime: true }], policy, subpaths), /unsupported consumer package/);
});
