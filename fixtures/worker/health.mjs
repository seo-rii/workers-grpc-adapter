import assert from 'node:assert/strict';
import grpc from '@grpc/grpc-js';
import adapter from '@grpc/grpc-js/adapter';
const { Client, Metadata, credentials, status, connectivityState } = grpc;
const { HealthClient } = grpc;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export default {
  async fetch(request, env) {
    const mode = env.MODE;
    const transport = adapter.createWorkersGrpcTransport({ mode,
      ...(mode === 'grpc-web' ? { endpoints: { 'health.test': 'https://health-gateway.test' } } : {}) });
    const client = new Client('health.test', credentials.createSsl(), transport.grpcOptions());
    const metadata = new Metadata(); metadata.set('x-health-runtime', `workerd-${mode}`);
    const h = new HealthClient(client), monitors = [];
    const results = [];
    try {
      for (const [service, expected] of [['', 1], ['not-serving', 2], ['unknown-enum', 99]]) {
        assert.equal((await h.check(service, { metadata, deadline: Date.now() + 3000 })).status, expected);
        results.push({ scenario: `check-${service || 'overall'}`, status: expected });
      }
      await assert.rejects(h.check('missing', { metadata }), { code: status.NOT_FOUND });
      results.push({ scenario: 'check-missing', code: status.NOT_FOUND });
      for (const service of ['transition', 'reconnect']) {
        const monitor = h.monitor(service, { metadata, initialBackoffMs: 5, maxBackoffMs: 20, backoffJitter: 0 });
        monitors.push(monitor);
        const state = await monitor.waitForServing({ deadline: Date.now() + 3000 });
        assert.equal(state.phase, 'serving'); assert.equal(state.servingStatus, 1);
        assert.equal(state.attempt, service === 'reconnect' ? 2 : 1);
        monitor.close(); assert.equal(monitor.getState().phase, 'closed');
        results.push({ scenario: `watch-${service}`, attempts: state.attempt });
      }
      const unsupported = h.monitor('unsupported', { metadata, initialBackoffMs: 5, maxBackoffMs: 20, backoffJitter: 0 });
      monitors.push(unsupported);
      await assert.rejects(unsupported.waitForServing({ deadline: Date.now() + 3000 }), { code: status.UNIMPLEMENTED });
      assert.equal(unsupported.getState().phase, 'disabled');
      await pause(30); assert.equal(unsupported.getState().attempt, 1);
      results.push({ scenario: 'watch-unsupported', attempts: 1 });
      const waiting = h.monitor('silent', { metadata }); monitors.push(waiting);
      await assert.rejects(waiting.waitForServing({ deadline: Date.now() + 40 }), { code: status.DEADLINE_EXCEEDED });
      const abort = new AbortController();
      const cancelled = assert.rejects(waiting.waitForServing({ deadline: Date.now() + 3000, signal: abort.signal }), { code: status.CANCELLED });
      abort.abort(); await cancelled; waiting.close();
      results.push({ scenario: 'watch-wait-deadline-abort', cancelled: true });
      assert.equal((await h.check('', { metadata })).status, 1);
      assert.equal(client.getChannel().getConnectivityState(false), connectivityState.IDLE);
      results.push({ scenario: 'client-reuse', status: 1 });
      return Response.json({ status: 'passed', mode, results });
    } catch (error) {
      return Response.json({ status: 'failed', code: error.code, message: error.message }, { status: 500 });
    } finally {
      for (const monitor of monitors) monitor.close();
      client.close();
    }
  },
};
