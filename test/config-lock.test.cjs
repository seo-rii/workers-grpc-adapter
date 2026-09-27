'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('CONFIG rejected Channel constructors leave global configuration available for correction', () => {
    const cases = [
        ["new grpc.Channel('https://invalid.test', grpc.credentials.createSsl())", 'WGA_INVALID_TARGET'],
        ["new grpc.Channel('valid.test', grpc.credentials.createSsl(), { 'grpc.max_receive_message_length': -2 })", 'WGA_UNSUPPORTED_OPTION'],
        ["new grpc.Channel('valid.test', grpc.credentials.createInsecure())", 'WGA_UNSUPPORTED_TLS'],
        ["new grpc.Channel('valid.test', {})", null],
    ];
    for (const [operation, code] of cases) {
        const script = `
            const assert = require('node:assert/strict');
            const grpc = require(${JSON.stringify(require.resolve('../dist/index.js'))});
            const config = require(${JSON.stringify(require.resolve('../dist/config.js'))});
            assert.throws(() => { ${operation}; }, ${code ? JSON.stringify({ code }) : 'TypeError'});
            const configured = config.configureWorkersGrpc({ defaultTimeoutMs: 1234 });
            assert.equal(configured.defaultTimeoutMs, 1234);
            const channel = new grpc.Channel('valid.test', grpc.credentials.createSsl());
            assert.throws(() => config.configureWorkersGrpc({ defaultTimeoutMs: 2345 }), { code: 'WGA_CONFIG_LOCKED' });
            channel.close();
        `;
        assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 }), '');
    }
});

test('CONFIG instance route validation and successful instance channels never lock the global configuration', () => {
    const script = `
        const assert = require('node:assert/strict');
        const grpc = require(${JSON.stringify(require.resolve('../dist/index.js'))});
        const { createWorkersGrpcTransport } = require(${JSON.stringify(require.resolve('../dist/adapter.js'))});
        const config = require(${JSON.stringify(require.resolve('../dist/config.js'))});
        const transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'valid.test': 'https://gateway.test' } });
        const options = transport.grpcOptions();
        assert.throws(() => new grpc.Channel('unmapped.test', grpc.credentials.createSsl(), options), { code: 'WGA_UNMAPPED_TARGET' });
        const channel = new grpc.Channel('valid.test', grpc.credentials.createSsl(), options);
        const configured = config.configureWorkersGrpc({ defaultTimeoutMs: 1234 });
        assert.equal(configured.defaultTimeoutMs, 1234);
        channel.close();
    `;
    assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 }), '');
});
