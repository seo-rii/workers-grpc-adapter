import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { createLookupAuth, runDatastoreLookup, lookupScenarios } from '../google/shared/datastore-lookup.mjs';

export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1);
    if (!lookupScenarios.includes(scenario)) return new Response('Not found', { status: 404 });
    const namespace = `${env.MODE}-${scenario}`;
    const transport = createWorkersGrpcTransport(env.MODE === 'cloudflare' ? { mode: 'cloudflare' } : {
      mode: 'grpc-web', endpoints: { 'datastore.googleapis.com': 'https://lookup-gateway.invalid' },
    });
    try {
      const result = await runDatastoreLookup({
        options: transport.gaxOptions({ projectId: 'wga-lookup', authClient: createLookupAuth() }), scenario, namespace,
        control: async operation => {
          const response = await fetch(`https://lookup-control.invalid/${namespace}/${operation}`, { method: 'POST' });
          if (!response.ok) throw new Error('lookup-control-failed');
          return response.json();
        },
      });
      return Response.json({ status: 'passed', result });
    } catch (error) {
      return Response.json({ status: 'failed', message: error.message, code: error.code }, { status: 500 });
    }
  },
};
