'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const grpc = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const helper = import('../fixtures/google/shared/sdk-call-accounting.mjs');
function reply(value) {
  const trailer = Buffer.from('grpc-status: 0\r\n'), header = Buffer.alloc(5);
  header[0] = 128; header.writeUInt32BE(trailer.length, 1);
  return new Response(Buffer.concat([Buffer.from([0, 0, 0, 0, 1, value]), header, trailer]),
    { headers: { 'content-type': 'application/grpc-web+proto' } });
}
function invoke(client, method) {
  return new Promise((resolve, reject) => client.makeUnaryRequest(method, bytes => bytes, bytes => [...bytes],
    Buffer.from([7]), (error, result) => error ? reject(error) : resolve(result)));
}

test('SDK accounting joins concurrent reversed responses to actual logical calls and checks ownership before close', async () => {
  const { startSdkCallAccounting } = await helper;
  const original = grpc.Channel.prototype.createCallForMethod, tracker = startSdkCallAccounting(grpc);
  const pending = [], receipts = [];
  let arrived;
  const arrivals = new Promise(resolve => { arrived = resolve; });
  const transport = createWorkersGrpcTransport({ mode: 'cloudflare', observer: tracker.observer,
    fetcher: { fetch: tracker.wrapFetcher((url, init) => {
      receipts.push({ id: init.headers.get('x-wga-sdk-call-id'), method: new URL(url).pathname });
      const response = new Promise(resolve => pending.push(resolve));
      if (pending.length === 2) arrived();
      return response;
    }) } });
  const clients = [0, 1].map(() => new grpc.Client('sdk-fixture.invalid', transport.channelCredentials, transport.grpcOptions()));
  try {
    const a = invoke(clients[0], '/sdk.Test/First'), b = invoke(clients[1], '/sdk.Test/Second');
    await arrivals; pending[1](reply(2)); assert.deepEqual(await b, [2]);
    pending[0](reply(1)); assert.deepEqual(await a, [1]);
    const result = await tracker.snapshot(transport);
    assert.equal(result.channelCount, 2); assert.equal(result.activeChannels, 0); assert.equal(result.beforeClose, true);
    assert.deepEqual(result.calls.map(call => ({ id: call.logicalCallId, method: call.method })), receipts);
    assert.equal(new Set(receipts.map(row => row.id)).size, 2);
    for (const call of result.calls) {
      assert.equal(call.fetchCount, 1); assert.equal(call.fetchEventCount, 1); assert.equal(call.authCount, 1);
      assert.equal(call.terminalCount, 1); assert.equal(call.statusCode, 0);
      assert.equal(call.diagnostics.timerActive, false); assert.ok(Object.values(call.execution).every(value => value === 0));
    }
    clients[0].close();
    await assert.rejects(tracker.snapshot(transport), /CHANNEL_IDLE_BEFORE_CLOSE/);
  } finally { for (const client of clients) client.close(); tracker.restore(); }
  assert.equal(grpc.Channel.prototype.createCallForMethod, original);
});

test('SDK accounting detects an additional physical Fetch even when observer call counts still equal one', async () => {
  const { startSdkCallAccounting } = await helper;
  const tracker = startSdkCallAccounting(grpc);
  let captured, release, arrived, physical = 0;
  const arrivals = new Promise(resolve => { arrived = resolve; });
  const fetcher = tracker.wrapFetcher((url, init) => {
    physical++; captured = { url, init };
    if (physical === 1) return new Promise(resolve => { release = resolve; arrived(); });
    return reply(2);
  });
  const transport = createWorkersGrpcTransport({ mode: 'cloudflare', observer: tracker.observer, fetcher: { fetch: fetcher } });
  const client = new grpc.Client('sdk-fixture.invalid', transport.channelCredentials, transport.grpcOptions());
  try {
    const pending = invoke(client, '/sdk.Test/One'); await arrivals;
    const extra = await fetcher(captured.url, captured.init); await extra.body.cancel();
    release(reply(1)); assert.deepEqual(await pending, [1]); assert.equal(physical, 2);
    await assert.rejects(tracker.snapshot(transport), /ONE_FETCH_PER_CALL/);
  } finally { client.close(); tracker.restore(); }
});

test('SDK accounting rejects uncorrelated Fetch and concurrent hook ownership and restores the original descriptor', async () => {
  const { startSdkCallAccounting } = await helper;
  const original = Object.getOwnPropertyDescriptor(grpc.Channel.prototype, 'createCallForMethod');
  const tracker = startSdkCallAccounting(grpc);
  try {
    assert.throws(() => startSdkCallAccounting(grpc), /ALREADY_TRACKING/);
    let forwarded = 0;
    const fetcher = tracker.wrapFetcher(() => { forwarded++; return reply(1); });
    await assert.rejects(fetcher('https://sdk-fixture.invalid/sdk.Test/One', { method: 'POST', headers: new Headers() }), /FETCH_CALL_ID/);
    assert.equal(forwarded, 0);
  } finally { tracker.restore(); tracker.restore(); }
  assert.deepEqual(Object.getOwnPropertyDescriptor(grpc.Channel.prototype, 'createCallForMethod'), original);
  const next = startSdkCallAccounting(grpc); next.restore();
});
