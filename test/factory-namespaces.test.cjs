'use strict';
const { test } = require('node:test');
const { assert, grpc, methods } = require('./helpers.cjs');

for (const name of ['toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
    test(`FACTORY owns inherited namespace ${name} and isolates package loads`, () => {
        const inherited = Object.prototype[name];
        const before = Object.getOwnPropertyDescriptors(inherited);
        try {
            const descriptor = { format: 'Protocol Buffer 3 DescriptorProto', type: { name: 'Message' } };
            const first = grpc.loadPackageDefinition({
                [`${name}.v1.Echo`]: methods,
                [`${name}.v1.Message`]: descriptor,
            });
            const firstClient = first[name].v1.Echo;
            const replacement = { unary: { ...methods.unary, path: '/other.Echo/Unary' } };
            const second = grpc.loadPackageDefinition({ [`${name}.v1.Echo`]: replacement });
            assert.equal(Object.hasOwn(first, name), true);
            assert.equal(Object.getPrototypeOf(first), Object.prototype);
            assert.equal(Object.getPrototypeOf(first[name]), Object.prototype);
            assert.notEqual(first[name], inherited);
            assert.notEqual(first[name], second[name]);
            assert.strictEqual(first[name].v1.Echo, firstClient);
            assert.strictEqual(first[name].v1.Echo.service, methods);
            assert.strictEqual(first[name].v1.Message, descriptor);
            assert.strictEqual(second[name].v1.Echo.service, replacement);
            assert.deepEqual(Object.getOwnPropertyDescriptors(inherited), before);
        } finally {
            // Restore globals when this regression test is run against the old implementation.
            for (const key of Reflect.ownKeys(inherited)) if (!Object.hasOwn(before, key)) delete inherited[key];
            Object.defineProperties(inherited, before);
        }
    });
}

test('FACTORY owns inherited names at each nested namespace', () => {
    const inherited = Object.prototype.toString;
    const before = Object.getOwnPropertyDescriptors(inherited);
    try {
        const tree = grpc.loadPackageDefinition({ 'demo.toString.v1.Echo': methods, 'demo.Other': methods });
        assert.equal(Object.hasOwn(tree.demo, 'toString'), true);
        assert.strictEqual(tree.demo.toString.v1.Echo.service, methods);
        assert.strictEqual(tree.demo.Other.service, methods);
        assert.deepEqual(Object.getOwnPropertyDescriptors(inherited), before);
    } finally {
        for (const key of Reflect.ownKeys(inherited)) if (!Object.hasOwn(before, key)) delete inherited[key];
        Object.defineProperties(inherited, before);
    }
});
