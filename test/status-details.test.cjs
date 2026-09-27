'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const fc = require('fast-check');
const dist = process.env.WGA_STATUS_DETAILS_DIST || path.resolve('dist');
const { decodeGrpcStatusDetails } = require(path.join(dist, 'status-details.js'));
const { Metadata } = require(path.join(dist, 'metadata.js'));
const protobuf = createRequire(path.resolve('fixtures/native/package.json'))('protobufjs');
const root = protobuf.parse('syntax="proto3"; message Any { string type_url=1; bytes value=2; } message Status { int32 code=1; string message=2; repeated Any details=3; }').root;
const Status = root.lookupType('Status');
const encode = value => Buffer.from(Status.encode(Status.create(value)).finish());
function original(bytes, code = 7) {
  const metadata = new Metadata();
  if (bytes !== undefined) metadata.set('grpc-status-details-bin', bytes);
  return Object.assign(new Error('original'), { code, details: 'original message', metadata });
}
test('STATUS DETAILS decodes protobufjs envelopes without overriding RPC status or unknown Any payloads', () => {
  const value = { code: 7, message: '\ufeffPermission λ denied', details: [{ typeUrl: 'type.googleapis.com/example.Detail', value: Buffer.from([0, 128, 255]) }] };
  const bytes = encode(value), status = original(bytes), result = decodeGrpcStatusDetails(status);
  assert.equal(result.status, status); assert.equal(result.diagnostic, undefined);
  assert.deepEqual(result.details, { ...value, details: value.details });
  assert.equal(status.details, 'original message'); assert.ok(Object.isFrozen(result.details.details));
  result.details.details[0].value[0] = 42;
  assert.deepEqual(status.metadata.get('grpc-status-details-bin')[0], bytes);
});
test('STATUS DETAILS isolates exact-URL decoder failure and copies decoder input', async () => {
  const typeUrl = 'type.googleapis.com/example.Detail';
  const status = original(encode({ code: 7, details: [{ typeUrl, value: Buffer.from('payload') }] }));
  const decoded = decodeGrpcStatusDetails(status, { decoders: { [typeUrl]: value => { value[0] = 0; return { reason: 'denied' }; } } });
  assert.deepEqual(decoded.details.details[0].decoded, { reason: 'denied' });
  assert.equal(decoded.details.details[0].value.toString(), 'payload');
  for (const decoder of [() => { throw new Error('decode failed'); }, () => Promise.reject(new Error('async unsupported')),
    () => ({ get then() { throw new Error('bad thenable'); } }),
    () => { const promise = Promise.reject(new Error('async with hostile then')); Object.defineProperty(promise, 'then', { get() { throw new Error('hostile then getter'); } }); return promise; }]) {
    const result = decodeGrpcStatusDetails(status, { decoders: { [typeUrl]: decoder } });
    assert.equal(result.status, status); assert.equal(result.diagnostic, undefined);
    assert.equal(result.details.details[0].diagnostic, 'decoder-failed');
    assert.equal(result.details.details[0].decoded, undefined);
  }
  await new Promise(resolve => setImmediate(resolve));
  const inherited = Object.create({ [typeUrl]: () => assert.fail('inherited decoder must not run') });
  assert.equal(decodeGrpcStatusDetails(status, { decoders: inherited }).details.details[0].decoded, undefined);
});
test('STATUS DETAILS preserves original errors on absent, duplicate, mismatched or malformed metadata', () => {
  const missing = original(); assert.equal(decodeGrpcStatusDetails(missing).diagnostic, 'absent');
  const multiple = original(Buffer.alloc(0)); multiple.metadata.add('grpc-status-details-bin', Buffer.alloc(0));
  assert.equal(decodeGrpcStatusDetails(multiple).diagnostic, 'multiple-values');
  const wrong = original(encode({ code: 14, message: 'unavailable' }));
  assert.equal(decodeGrpcStatusDetails(wrong).diagnostic, 'code-mismatch'); assert.equal(wrong.code, 7);
  for (const bytes of [Buffer.from([0]), Buffer.from([8, 128]), Buffer.from([18, 2, 97]), Buffer.from([18, 1, 255]),
    Buffer.from([26, 2, 10, 128]), Buffer.from([10, 0]), Buffer.alloc(12, 255), Buffer.from([35, 44]), Buffer.from([36])]) {
    const status = original(bytes), result = decodeGrpcStatusDetails(status);
    assert.equal(result.status, status); assert.equal(result.diagnostic, 'invalid-protobuf'); assert.equal(result.details, undefined);
  }
  const adversarial = { code: 7, details: 'unchanged', metadata: { get() { throw new Error('metadata getter failed'); } } };
  assert.equal(decodeGrpcStatusDetails(adversarial).status, adversarial);
});
test('STATUS DETAILS checks total bytes, Any count and nested groups before invoking application decoders', () => {
  const item = { typeUrl: 'type.test/Value', value: Buffer.alloc(12) };
  const bytes = encode({ code: 7, details: [item, item] }); let calls = 0;
  const decoders = { [item.typeUrl]: () => { calls++; } };
  for (const options of [{ maxBytes: bytes.length - 1 }, { maxDetails: 1 }]) {
    assert.equal(decodeGrpcStatusDetails(original(bytes), { ...options, decoders }).diagnostic, 'limit-exceeded');
  }
  assert.equal(decodeGrpcStatusDetails(original(Buffer.concat([bytes, Buffer.from([0])])), { decoders }).diagnostic, 'invalid-protobuf');
  assert.equal(calls, 0);
  const groups = Buffer.concat([Buffer.alloc(33, 35), Buffer.alloc(33, 36)]);
  assert.equal(decodeGrpcStatusDetails(original(groups)).diagnostic, 'limit-exceeded');
  assert.equal(decodeGrpcStatusDetails(original(bytes), { maxBytes: bytes.length, maxDetails: 2 }).details.details.length, 2);
  for (const options of [{ maxBytes: 0 }, { maxBytes: Infinity }, { maxBytes: 4194305 }, { maxDetails: 0 }, { maxDetails: 1025 }]) {
    assert.throws(() => decodeGrpcStatusDetails(original(bytes), options), /WGA_INVALID_STATUS_DETAILS_LIMIT/);
  }
});
test('STATUS DETAILS follows protobuf duplicate scalar and unknown-field rules', () => {
  const bytes = Buffer.concat([encode({ code: 14, message: 'first' }), Buffer.from([35, 8, 99, 36]),
    Buffer.from([41, 0, 0, 0, 0, 0, 0, 0, 0, 53, 0, 0, 0, 0, 58, 1, 0]), encode({ code: 7, message: 'last' })]);
  assert.deepEqual(decodeGrpcStatusDetails(original(bytes)).details, { code: 7, message: 'last', details: [] });
});
test('STATUS DETAILS fuzz valid independent protobuf encodings and arbitrary bounded bytes', () => {
  fc.assert(fc.property(fc.record({ code: fc.integer({ min: 0, max: 16 }), message: fc.string({ maxLength: 100 }),
    details: fc.array(fc.record({ typeUrl: fc.string({ maxLength: 60 }), value: fc.uint8Array({ maxLength: 64 }) }), { maxLength: 8 }) }), value => {
    const encoded = encode(value), expected = Status.toObject(Status.decode(encoded), { defaults: true, bytes: Buffer });
    const result = decodeGrpcStatusDetails(original(encoded, value.code));
    assert.deepEqual(result.details, expected); assert.equal(result.diagnostic, undefined);
  }), { seed: 20260927, numRuns: 2000 });
  fc.assert(fc.property(fc.uint8Array({ maxLength: 1024 }), bytes => {
    const value = Buffer.from(bytes), before = Buffer.from(value), status = original(value);
    const result = decodeGrpcStatusDetails(status); assert.equal(result.status, status); assert.equal(status.code, 7);
    assert.deepEqual(value, before);
    if (result.details) assert.equal(result.details.code, status.code);
  }), { seed: 8675309, numRuns: 3000 });
});
