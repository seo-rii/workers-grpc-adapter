import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { client } from 'doc-example-consumer';

function transportCall(surface) {
  const seen = new Set();
  for (let current = surface; current && !seen.has(current); current = current.call ?? current.nextCall) {
    if (typeof current.diagnostics === 'function') return current;
    seen.add(current);
  }
  throw new Error('Documentation RPC did not reach the installed transport');
}
export default {
  async fetch() {
    const nativeFetch = globalThis.fetch, fetchIntents = [], callbacks = [], statusCodes = [];
    globalThis.fetch = async (url, init) => {
      fetchIntents.push({ url: String(url), method: init.method, grpcWeb: init.cf?.grpcWeb,
        contentType: init.headers.get('content-type'), redirect: init.redirect, payloadHex: Buffer.from(init.body).toString('hex') });
      return nativeFetch(url, init);
    };
    let call, bottom, result;
    try {
      const done = new Promise((resolve, reject) => {
        call = client.makeUnaryRequest('/package.Service/Method', () => Buffer.from([10, 2, 111, 107]), bytes => bytes.toString('hex'), {}, (error, value) => {
          callbacks.push({ code: error?.code ?? 0, value: value ?? null });
          if (error) reject(error);
        });
        call.on('status', status => { statusCodes.push(status.code); resolve(); });
      });
      await done;
      bottom = transportCall(call);
      for (let step = 0; step < 100 && Object.values(bottom.executionDiagnostics()).some(value => value !== 0); step++) await new Promise(resolve => setTimeout(resolve, 1));
      assert.deepEqual(callbacks, [{ code: 0, value: '0a026f6b' }]); assert.deepEqual(statusCodes, [0]);
      result = { callbacks, statusCodes, fetchIntents, diagnostics: bottom.diagnostics(), execution: bottom.executionDiagnostics(),
        channelActiveCalls: client.getChannel().active.size, rpcCount: 1, fetchCount: fetchIntents.length };
      assert.equal(result.channelActiveCalls, 0);
      assert.ok(Object.values(result.execution).every(value => value === 0));
    } finally { globalThis.fetch = nativeFetch; client.close(); }
    return Response.json({ ...result, clientClosed: true });
  },
};
