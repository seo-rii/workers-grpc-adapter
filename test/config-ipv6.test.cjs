'use strict';
const { test } = require('node:test');
const { isIP } = require('node:net');
const { assert, Echo, response } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { normalizeAuthority, validateConfig } = require('../dist/config-internal.js');

const mixed = [
  '[::ffff:127.0.0.1]',
  '[0:0:0:0:0:ffff:127.0.0.1]:443',
  '[::192.0.2.1]:8443',
  '[2001:db8::192.0.2.1]:9443',
];
const canonical = target => {
  const url = new URL('https://' + target);
  return url.hostname + ':' + (url.port || 443);
};

for (const target of mixed) {
  test(`CONFIG canonicalizes IPv4-embedded IPv6 authority ${target}`, () => {
    assert.equal(isIP(target.slice(1, target.indexOf(']'))), 6);
    assert.equal(normalizeAuthority(target), canonical(target));
    assert.equal(normalizeAuthority(canonical(target)), canonical(target));
  });
}

for (const mode of ['cloudflare', 'grpc-web']) {
  for (const [key, address] of [
    ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]:443'],
    ['[::ffff:7f00:1]:443', '[::ffff:127.0.0.1]'],
    ['[2001:db8::192.0.2.1]:9443', '[2001:db8::c000:201]:9443'],
    ['[2001:db8::c000:201]:9443', '[2001:db8::192.0.2.1]:9443'],
  ]) {
    test(`CONFIG routes ${mode} mixed IPv6 alias ${address} with mapping ${key}`, async () => {
      const seen = [];
      const transport = createWorkersGrpcTransport({ mode,
        ...(mode === 'grpc-web' ? { endpoints: { [key]: 'https://gateway.test' } } : {}),
        fetcher: { async fetch(url, init) {
          seen.push({ url: String(url), conversion: init.cf.grpcWeb });
          return response();
        } },
      });
      const client = new Echo(address, transport.channelCredentials, transport.grpcOptions());
      try {
        const value = await new Promise((resolve, reject) => client.unary({ text: 'test' },
          (error, result) => error ? reject(error) : resolve(result)));
        assert.deepEqual(value, { text: 'ok' });
        assert.deepEqual(seen, [{
          url: (mode === 'grpc-web' ? 'https://gateway.test' : new URL('https://' + address).origin) + '/demo.Echo/Unary',
          conversion: mode === 'grpc-web' ? 'passthrough' : 'convert',
        }]);
        assert.equal(client.getChannel().activeCallCount(), 0);
        assert.equal(transport.resourceUsage().bufferedBytes, 0);
      } finally { client.close(); }
    });
  }
}

test('CONFIG rejects duplicate equivalent mixed and hex IPv6 mapping keys', () => {
  assert.throws(() => validateConfig({ mode: 'grpc-web', endpoints: {
    '[::ffff:127.0.0.1]': 'https://first.test',
    '[::ffff:7f00:1]:443': 'https://second.test',
  } }), { code: 'WGA_INVALID_CONFIG' });
});

for (const target of [
  '[::ffff:127.0.0.256]', '[::ffff:127.0.0]', '[::ffff:127.0.0.01]',
  '[::ffff:127.0.0.1.2]', '[1:2:3:4:5:6:7:192.0.2.1]', '[::ffff:127.0.0.1]:0',
  '[::ffff:127.0.0.1]:65536', '[::ffff:127.0.0.1%eth0]',
  'https://[::ffff:127.0.0.1]', 'user@[::ffff:127.0.0.1]',
  '[::ffff:127.0.0.1]/path', '[::ffff:127.0.0.1]?query', '[::ffff:127.0.0.1]#fragment',
  '[::ffff:127.0.0.1]\\path',
]) {
  test(`CONFIG still rejects invalid mixed IPv6 target ${target}`, () => {
    assert.throws(() => normalizeAuthority(target), { code: 'WGA_INVALID_TARGET' });
  });
}

for (const origin of ['http://[::ffff:127.0.0.1]:8000', 'http://[::ffff:7f00:1]:8000', 'http://[::127.0.0.1]:8000']) {
  test(`CONFIG preserves the literal loopback origin restriction for ${origin}`, () => {
    assert.throws(() => validateConfig({ mode: 'grpc-web', allowInsecureLocalhost: true,
      endpoints: { 'logical.test': origin } }), { code: 'WGA_INVALID_CONFIG' });
  });
}
