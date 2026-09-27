import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

export default {
  async fetch(request) {
    try {
      const input = await request.json();
      // All SDK imports occur on the first request, exercising the new profile's
      // static protobuf replacements after workerd disables runtime eval.
      const [{ runModernSDK }, { OAuth2Client }] = await Promise.all([
        import('./shared.mjs'), import('google-auth-library'),
      ]);
      const authClient = new OAuth2Client();
      authClient.setCredentials({ access_token: input.token, expiry_date: Date.now() + 3600000 });
      const transport = createWorkersGrpcTransport(input.mode === 'cloudflare' ? { mode: 'cloudflare' } : {
        mode: 'grpc-web', endpoints: {
          'datastore.googleapis.com': 'https://gateway.fixture.invalid',
          'firestore.googleapis.com': 'https://gateway.fixture.invalid',
          'secretmanager.googleapis.com': 'https://gateway.fixture.invalid',
        },
      });
      const checks = await runModernSDK({ sdk: input.sdk, options: transport.gaxOptions({ projectId: 'wga-local-test', authClient }), runId: input.runId });
      return Response.json({ status: 'passed', checks });
    } catch (error) {
      return Response.json({ status: 'failed', diagnostic: error.fixtureDiagnostic || 'MODERN_WORKER_SDK_FAILURE', errorClass: error.constructor?.name || 'Error',
        errorCode: typeof error.code === 'number' || /^WGA_[A-Z_]+$/.test(error.code || '') ? error.code : undefined }, { status: 500 });
    }
  },
};
