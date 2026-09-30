'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectConsumerImports } = require('../scripts/consumer-imports.cjs');
const grpc = '@grpc/grpc-js';
function record(kind, names, options = {}) {
    return { specifier: grpc, kind, runtime: true, names, namespace: false, dynamicAccess: false, ...options };
}

test('consumer inventory distinguishes named runtime and type imports/reexports', () => {
    const records = inspectConsumerImports(`
        import { Metadata as Meta, type ClientOptions } from '${grpc}';
        import type { ServiceError } from '${grpc}';
        export { status as Status, type CallOptions } from '${grpc}';
        export type { MethodDefinition } from '${grpc}';
        import type { Client } from '${grpc}/build/src/client.js';
        import '${grpc}';
    `, 'consumer.ts');
    assert.deepEqual(records, [
        record('export', ['CallOptions', 'MethodDefinition'], { runtime: false }),
        record('export', ['status']),
        record('import', ['ClientOptions', 'ServiceError'], { runtime: false }),
        record('import', ['Metadata']),
        record('import', ['Client'], { specifier: `${grpc}/build/src/client.js`, runtime: false }),
    ]);
});

test('consumer namespace inventory uses lexical symbols and first-level members', () => {
    assert.deepEqual(inspectConsumerImports(`
        import * as grpc from '${grpc}';
        new grpc.Metadata(); grpc.credentials.createSsl(); grpc['status'].OK;
        const { Channel: ChannelType } = grpc;
        let options: grpc.CallOptions;
        function shadow(grpc: { Server: unknown }) { return grpc.Server; }
    `, 'consumer.ts'), [record('import', ['CallOptions', 'Channel', 'Metadata', 'credentials', 'status'], { namespace: true })]);
});

test('consumer inventory handles CommonJS, importStar, destructuring and package metadata without evaluation', () => {
    assert.deepEqual(inspectConsumerImports(`
        const grpc = __importStar(require('${grpc}'));
        grpc.Metadata; grpc.credentials.createInsecure();
        var raw = require('${grpc}'); raw.status.OK;
        const { Client: Rpc, credentials: { createSsl }, ['Channel']: Channel } = require('${grpc}');
        require('${grpc}/package.json').version;
        const deep = require('${grpc}/build/src/client'); deep.Client;
        throw new Error('must never execute');
    `, 'consumer.js'), [
        record('require', ['Channel', 'Client', 'credentials']),
        record('require', ['Metadata', 'credentials', 'status'], { namespace: true }),
        record('require', ['Client'], { specifier: `${grpc}/build/src/client`, namespace: true }),
        record('require', ['version'], { specifier: `${grpc}/package.json`, namespace: true }),
    ]);
});

test('consumer declaration and explicit import types never count as runtime imports', () => {
    const source = `import * as grpc from '${grpc}';
        export { Metadata } from '${grpc}';
        import Client = require('${grpc}/build/src/client');
        type Options = grpc.CallOptions;
        type Deep = Client.Client;
        type Credential = import('${grpc}').credentials.ChannelCredentials;
        type Whole = typeof import('${grpc}');`;
    const records = inspectConsumerImports(source, 'consumer.d.ts');
    assert.equal(records.length, 5);
    assert.ok(records.every(record => !record.runtime));
    assert.ok(records.some(record => record.kind === 'import-type' && record.names.join() === 'credentials' && !record.dynamicAccess));
    assert.ok(records.some(record => record.kind === 'import-type' && record.namespace && record.dynamicAccess));
    assert.deepEqual(inspectConsumerImports(`import type grpc = require('${grpc}'); type C = grpc.Client;`, 'consumer.ts'),
        [record('import-equals', ['Client'], { namespace: true, runtime: false })]);
    assert.deepEqual(inspectConsumerImports(`declare module 'ambient' { import { Client } from '${grpc}'; }`, 'consumer.ts'),
        [record('import', ['Client'], { runtime: false })]);
});

test('consumer inventory exposes namespace escapes and dynamic access instead of a complete-name claim', () => {
    for (const use of ['consume(grpc)', 'grpc[key]', 'const copy = grpc', 'const copy = {grpc}', 'export {grpc}', 'type All = typeof grpc']) {
        assert.deepEqual(inspectConsumerImports(`import * as grpc from '${grpc}'; grpc.Metadata; ${use};`, 'consumer.ts'),
            [record('import', ['Metadata'], { namespace: true, dynamicAccess: true })], use);
    }
    assert.deepEqual(inspectConsumerImports(`const { Metadata, ...rest } = require('${grpc}');`, 'consumer.js'),
        [record('require', ['Metadata'], { dynamicAccess: true })]);
    assert.deepEqual(inspectConsumerImports(`export * from '${grpc}'; export * as rpc from '${grpc}';`, 'consumer.ts'),
        [record('export', [], { namespace: true, dynamicAccess: true })]);
    assert.deepEqual(inspectConsumerImports(`const rpc = await import('${grpc}');`, 'consumer.mjs'),
        [record('dynamic-import', [], { namespace: true, dynamicAccess: true })]);
});

test('consumer inventory ignores comments, strings, unrelated imports and locally shadowed require', () => {
    assert.deepEqual(inspectConsumerImports(`
        // const grpc = require('${grpc}'); grpc.Server;
        const text = "import {Server} from '${grpc}'";
        const other = require('@grpc/proto-loader');
        function local(require) { return require('${grpc}').Server; }
    `, 'consumer.js'), []);
    assert.deepEqual(inspectConsumerImports(`import {Server} from '@grpc/grpc-js-extra';`, 'consumer.ts'), []);
});

test('consumer import inventory is deterministic and rejects malformed relevant source', () => {
    const first = `const grpc = require('${grpc}'); grpc.Metadata; grpc.Client; grpc.Metadata;`;
    const second = `const grpc = require('${grpc}'); grpc.Client; grpc.Metadata;`;
    assert.deepEqual(inspectConsumerImports(first, 'consumer.cjs'), inspectConsumerImports(second, 'consumer.cjs'));
    assert.throws(() => inspectConsumerImports(`import { from '${grpc}';`, 'broken.ts'), /Cannot inventory malformed consumer source: broken.ts:/);
    assert.throws(() => inspectConsumerImports(null, 'consumer.js'), TypeError);
});
