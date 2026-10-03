import * as grpc from '@grpc/grpc-js';
import { startSdkCallAccounting } from './shared/sdk-call-accounting.mjs';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { OAuth2Client } from 'google-auth-library';
import { runDatastorePagination, paginationScenarios } from './shared/datastore-pagination.mjs';

export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1);
    if (!paginationScenarios.includes(scenario)) return new Response('Not found', { status: 404 });
    const namespace = `${env.MODE}-${scenario}`;
    const authClient = new OAuth2Client();
    authClient.setCredentials({ access_token: 'pagination-local-fixture' });
    let authNetworkRequests = 0;
    authClient.transporter.request = async () => { authNetworkRequests++; throw new Error('unexpected-pagination-auth-network'); };
    const tracker = startSdkCallAccounting(grpc);
    const transport = createWorkersGrpcTransport({ ...(env.MODE === 'cloudflare' ? { mode: 'cloudflare' } : {
      mode: 'grpc-web', endpoints: { 'datastore.googleapis.com': 'https://pagination-gateway.invalid' },
    }), observer: tracker.observer, fetcher: { fetch: tracker.wrapFetcher(fetch) } });
    try {
      const result = await runDatastorePagination({
        options: transport.gaxOptions({ projectId: 'wga-pagination', authClient }), scenario, namespace,
        beforeClose: () => tracker.snapshot(transport),
        control: async operation => {
          const response = await fetch(`https://pagination-control.invalid/${namespace}/${operation}`, { method: 'POST' });
          if (!response.ok) throw new Error('pagination-control-failed');
          return response.json();
        },
      });
      return Response.json({ status: 'passed', result, authNetworkRequests });
    } catch (error) {
      return Response.json({ status: 'failed', message: error.message, code: error.code }, { status: 500 });
    } finally { tracker.restore(); }
  },
};
