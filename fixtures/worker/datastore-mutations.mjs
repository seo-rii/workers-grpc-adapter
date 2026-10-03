import * as grpc from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { runDatastoreMutations, mutationScenarios } from '../google/shared/datastore-mutations.mjs';
import { startSdkCallAccounting } from '../google/shared/sdk-call-accounting.mjs';
export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1);
    if (!mutationScenarios.includes(scenario)) return new Response('Not found', { status: 404 });
    const tracker = startSdkCallAccounting(grpc); let dataFetches = 0, accounting;
    try {
      const transport = createWorkersGrpcTransport({ mode: env.MODE,
        ...(env.MODE === 'grpc-web' ? { endpoints: { 'datastore.googleapis.com': 'https://mutation-gateway.invalid' } } : {}),
        observer: tracker.observer, fetcher: { fetch: tracker.wrapFetcher((url, init) => { dataFetches++; return fetch(url, init); }) } });
      const result = await runDatastoreMutations({ options: transport.gaxOptions({ projectId: 'wga-mutations' }), scenario,
        namespace: `workerd-${env.MODE}-${scenario}`, beforeClose: async () => { accounting = await tracker.snapshot(transport); } });
      return Response.json({ status: 'passed', result, accounting, dataFetches, authFetches: 0, controlRequests: 0 });
    } catch (error) { return Response.json({ status: 'failed', message: error.message, code: error.code }, { status: 500 }); }
    finally { tracker.restore(); }
  },
};
