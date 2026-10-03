import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { runDatastoreTransactions, observeTransactionCalls, safeTransactionError } from '../google/shared/datastore-transactions.mjs';
export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1), caseId = `${env.PROFILE}/workerd-${env.MODE}/${scenario}`;
    const events = [], transport = createWorkersGrpcTransport({ observer: event => events.push(event),
      ...(env.MODE === 'cloudflare' ? { mode: 'cloudflare' } : { mode: 'grpc-web', endpoints: { 'datastore.googleapis.com': 'https://datastore-transaction-gateway.invalid',
        'datastore-a.googleapis.com': 'https://datastore-transaction-gateway-a.invalid',
        'datastore-b.googleapis.com': 'https://datastore-transaction-gateway-b.invalid' } }) });
    try {
      let observer;
      const result = await runDatastoreTransactions({ options: transport.gaxOptions({ projectId: 'demo-wga-transactions' }), scenario, caseId,
        control: async operation => { const response = await fetch(`https://datastore-transaction-control.invalid/${operation}`, { method: 'POST', headers: { 'x-wga-case': caseId } });
          if (response.status !== 204) throw Object.assign(new Error('TX_CONTROL_FAILURE'), { fixtureDiagnostic: 'TX_CONTROL_FAILURE' }); },
        beforeClose: async () => { observer = await observeTransactionCalls(events, transport); } });
      return Response.json({ status: 'passed', result, observer });
    } catch (error) { return Response.json({ status: 'failed', diagnostic: safeTransactionError(error) }, { status: 500 }); }
  },
};
