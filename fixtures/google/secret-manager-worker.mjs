import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { OAuth2Client } from 'google-auth-library';
import { runSecretManagerExtended, secretManagerScenarios, safeSecretManagerError } from './shared/secret-manager-extended.mjs';

export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1);
    if (!secretManagerScenarios.includes(scenario)) return new Response('Not found', { status: 404 });
    const authClient = new OAuth2Client();
    authClient.setCredentials({ access_token: 'secret-manager-local-fixture' });
    const transport = createWorkersGrpcTransport(env.MODE === 'cloudflare' ? { mode: 'cloudflare' } : {
      mode: 'grpc-web', endpoints: { 'secretmanager.googleapis.com': 'https://secret-manager-gateway.invalid' },
    });
    try {
      const result = await runSecretManagerExtended({ options: transport.gaxOptions({ projectId: 'wga-sm-fixture', authClient }),
        scenario, caseId: `${env.MODE}-${scenario}` });
      return Response.json({ status: 'passed', result });
    } catch (error) {
      // Never echo raw SDK exceptions: they may hold request or payload data.
      return Response.json({ status: 'failed', error: safeSecretManagerError(error) }, { status: 500 });
    }
  },
};
