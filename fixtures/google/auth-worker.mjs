import { Buffer } from 'node:buffer';
import * as grpc from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { OAuth2Client, JWT } from 'google-auth-library';
import { OAuth2Client as OAuth2ClientV11, JWT as JWTV11 } from '@google-cloud/secret-manager/node_modules/google-auth-library';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const rpcPath = '/fixture.Auth/Echo';
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
function check(condition, diagnostic) {
  if (!condition) { const error = new Error(); error.fixtureDiagnostic = diagnostic; throw error; }
}
function invoke(client, owner, deadline = 5000) {
  const trace = [];
  let callbacks = 0, call;
  const settled = new Promise(resolve => {
    call = client.makeUnaryRequest(rpcPath, value => Buffer.from(value), value => value.toString(), owner,
      { deadline: Date.now() + deadline }, (error, value) => {
        callbacks++;
        trace.push('callback');
        resolve({ error, value });
      });
  });
  call.on('metadata', () => trace.push('metadata'));
  call.on('status', value => trace.push(`status:${value.code}`));
  return { call, settled, trace, callbacks: () => callbacks };
}
async function succeeded(invocation) {
  const { error, value } = await invocation.settled;
  await turn();
  check(!error && value === 'accepted', 'RPC_SUCCESS');
  check(invocation.callbacks() === 1, 'CALLBACK_ONCE');
  check(invocation.trace.join(',') === 'metadata,callback,status:0', 'SUCCESS_EVENT_ORDER');
}

export default {
  async fetch(request) {
    const clients = [];
    let stage = 'input';
    try {
      // Credentials and the ephemeral RSA key exist only in this invocation.
      const input = await request.json();
      const transport = createWorkersGrpcTransport(input.mode === 'cloudflare' ? { mode: 'cloudflare' } : {
        mode: 'grpc-web', endpoints: {
          'logical.fixture.invalid': 'https://gateway.fixture.invalid',
          'secretmanager.googleapis.com': 'https://gateway.fixture.invalid',
        },
      });
      const authFor = identity => {
        const options = { quotaProjectId: identity.quota };
        const OAuth = input.authVersion === '11.1.0' ? OAuth2ClientV11 : OAuth2Client;
        const ServiceAccount = input.authVersion === '11.1.0' ? JWTV11 : JWT;
        const auth = identity.kind === 'jwt'
          ? new ServiceAccount({ ...options, email: identity.email, key: identity.privateKey, scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
          : new OAuth({ ...options, clientId: identity.clientId, clientSecret: identity.clientSecret,
            endpoints: { oauth2TokenUrl: `https://oauth.fixture.invalid/token/${identity.id}` } });
        if (identity.kind !== 'jwt') auth.setCredentials({ access_token: identity.accessToken, refresh_token: identity.refreshToken,
          expiry_date: Date.now() + (identity.expired ? -1000 : 3600000) });
        return auth;
      };
      const auths = input.identities.map(authFor);
      const direct = auth => {
        const credentials = grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), grpc.credentials.createFromGoogleCredential(auth));
        const client = new grpc.Client('logical.fixture.invalid', credentials, transport.grpcOptions());
        clients.push(() => client.close());
        return client;
      };
      const control = async (action, index = 0) => {
        const response = await fetch(`https://control.fixture.invalid/${action}/${input.identities[index].id}`);
        check(response.ok, 'CONTROL_ENDPOINT');
        await response.text();
      };
      stage = input.scenario;
      if (input.scenario === 'sdk-refresh') {
        const sdk = new SecretManagerServiceClient(transport.gaxOptions({ projectId: 'wga-auth-fixture', authClient: auths[0] }));
        clients.push(() => sdk.close());
        const name = `projects/wga-auth-fixture/secrets/${input.identities[0].id}`;
        for (let i = 0; i < 2; i++) {
          const [secret] = await sdk.getSecret({ name }, { retry: null, timeout: 5000 });
          check(secret.name === name, 'SDK_RESPONSE');
        }
      } else {
        const directClients = auths.map(direct);
        const run = (index = 0, suffix = '') => invoke(directClients[index], `${input.identities[index].id}${suffix}`);
        if (['valid-cache', 'expired-refresh', 'jwt-exchange'].includes(input.scenario)) {
          await succeeded(run());
          await succeeded(run());
        } else if (input.scenario === 'concurrent-refresh') {
          const calls = Array.from({ length: 12 }, () => run());
          await control('started');
          await control('release');
          await Promise.all(calls.map(succeeded));
        } else if (input.scenario === 'isolated-refresh') {
          const left = run(0), right = run(1);
          await Promise.all([control('started', 0), control('started', 1)]);
          await control('release', 1);
          await succeeded(right);
          await control('release', 0);
          await succeeded(left);
          await Promise.all([succeeded(run(0)), succeeded(run(1))]);
        } else if (input.scenario === 'denied-refresh') {
          const denied = run();
          const { error } = await denied.settled;
          await turn();
          check(error?.code === grpc.status.INTERNAL && error.details === 'WGA_AUTH_METADATA', 'DENIED_SANITIZED');
          check(denied.callbacks() === 1 && denied.trace.join(',') === 'callback,status:13', 'DENIED_EVENT_ORDER');
          await succeeded(run());
        } else if (['cancel-refresh', 'deadline-refresh'].includes(input.scenario)) {
          const deadline = input.scenario === 'deadline-refresh';
          const stopped = invoke(directClients[0], `${input.identities[0].id}-stopped`, deadline ? 1000 : 5000);
          await control('started');
          if (!deadline) stopped.call.cancel();
          const { error } = await stopped.settled;
          const code = deadline ? grpc.status.DEADLINE_EXCEEDED : grpc.status.CANCELLED;
          check(error?.code === code, 'REFRESH_INTERRUPTION_CODE');
          await control('release');
          await auths[0].getRequestHeaders('https://logical.fixture.invalid/fixture.Auth');
          await turn();
          check(stopped.callbacks() === 1 && stopped.trace.join(',') === `callback,status:${code}`, 'REFRESH_INTERRUPTION_ONCE');
          await succeeded(run());
        } else check(false, 'UNKNOWN_SCENARIO');
      }
      for (let i = 0; i < auths.length; i++) {
        check(auths[i].credentials.expiry_date > Date.now(), 'CREDENTIAL_EXPIRY');
        if (input.identities[i].kind !== 'jwt') check(auths[i].credentials.refresh_token === input.identities[i].refreshToken, 'REFRESH_TOKEN_PRESERVED');
      }
      return Response.json({ status: 'passed', scenario: input.scenario, mode: input.mode, authVersion: input.authVersion });
    } catch (error) {
      // Gaxios errors can contain token bodies, assertions and private keys.
      return Response.json({ status: 'failed', stage, diagnostic: error.fixtureDiagnostic || 'AUTH_RUNTIME_FAILURE',
        errorClass: error.constructor?.name || 'Error' }, { status: 500 });
    } finally { await Promise.all(clients.map(close => close())); }
  },
};
