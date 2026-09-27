'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateOptions } = require('../dist/options.js');
const { validateConfig } = require('../dist/config-internal.js');

test('MODERN Firestore native transport defaults are inert compatibility hints', () => {
  const config = validateConfig({ transportMaxReceiveBytes: 1024, transportMaxSendBytes: 2048 });
  const options = { 'grpc-node.flow_control_window': 262144, 'grpc.use_local_subchannel_pool': 1 };
  assert.deepEqual(validateOptions(options, 'echo.test:443', config), validateOptions({}, 'echo.test:443', config));
  assert.deepEqual(validateOptions({ ...options, 'grpc.max_receive_message_length': 64 }, 'echo.test:443', config),
    validateOptions({ 'grpc.max_receive_message_length': 64 }, 'echo.test:443', config));
});

test('MODERN native transport hints reject custom values and other transport options', () => {
  for (const [key, valid] of [['grpc-node.flow_control_window', 262144], ['grpc.use_local_subchannel_pool', 1]]) {
    for (const value of [null, false, true, 0, -1, 2, 65535, 262143, 262145, `${valid}`, NaN, Infinity, {}, []]) {
      assert.throws(() => validateOptions({ [key]: value }, 'echo.test:443', validateConfig()), { code: 'WGA_UNSUPPORTED_OPTION' });
    }
  }
  for (const key of ['grpc-node.max_session_memory', 'grpc.keepalive_time_ms', 'grpc.default_compression_level']) {
    assert.throws(() => validateOptions({ [key]: 1 }, 'echo.test:443', validateConfig()), { code: 'WGA_UNSUPPORTED_OPTION' });
  }
});
