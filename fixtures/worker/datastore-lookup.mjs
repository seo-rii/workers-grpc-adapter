import * as grpc from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { createLookupAuth, calibrateLookupAuth, runDatastoreLookup, lookupScenarios } from '../google/shared/datastore-lookup.mjs';
import { startSdkCallAccounting } from '../google/shared/sdk-call-accounting.mjs';

export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1);
    if (!lookupScenarios.includes(scenario)) return new Response('Not found', { status: 404 });
    const namespace = `${env.MODE}-${scenario}`;
    const tracker = startSdkCallAccounting(grpc);
    let dataFetches = 0, authFetches = 0, authNetworkRequests = 0, controlRequests = 0, accounting;
    try {
      const transport = createWorkersGrpcTransport({ mode: env.MODE,
        ...(env.MODE === 'grpc-web' ? { endpoints: { 'datastore.googleapis.com': 'https://lookup-gateway.invalid' } } : {}),
        observer: tracker.observer,
        fetcher: { fetch: tracker.wrapFetcher((url, init) => { dataFetches++; return fetch(url, init); }) },
      });
      const authCalibration = await calibrateLookupAuth();
      const result = await runDatastoreLookup({
        options: transport.gaxOptions({ projectId: 'wga-lookup', authClient: createLookupAuth(() => { authNetworkRequests++; }) }), scenario, namespace,
        beforeClose: async () => { accounting = await tracker.snapshot(transport); },
        control: async operation => {
          controlRequests++;
          const response = await fetch(`https://lookup-control.invalid/${namespace}/${operation}`, { method: 'POST' });
          if (!response.ok) throw new Error('lookup-control-failed');
          return response.json();
        },
      });
      return Response.json({ status: 'passed', result, accounting, authCalibration, dataFetches, authFetches, authNetworkRequests, controlRequests });
    } catch (error) {
      return Response.json({ status: 'failed', message: error.message, code: error.code }, { status: 500 });
    } finally { tracker.restore(); }
  },
};
