import { Buffer } from 'node:buffer';
import * as grpc from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { ExternalAccountClient, IdentityPoolClient, Impersonated, OAuth2Client } from 'google-auth-library';
import {
  ExternalAccountClient as ExternalAccountClientV11, IdentityPoolClient as IdentityPoolClientV11,
  Impersonated as ImpersonatedV11, OAuth2Client as OAuth2ClientV11,
} from '@google-cloud/secret-manager/node_modules/google-auth-library';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const turn = () => new Promise(resolve => setTimeout(resolve, 0));
function check(condition, diagnostic) {
  if (!condition) { const error = new Error(); error.fixtureDiagnostic = diagnostic; throw error; }
}
function invoke(client, owner, deadline = 5000) {
  const trace = [];
  let callbacks = 0, call;
  const settled = new Promise(resolve => {
    call = client.makeUnaryRequest('/fixture.FederatedAuth/Echo', value => Buffer.from(value), value => value.toString(), owner,
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
      // Test credential configuration is created by the local runner; production
      // applications must not accept arbitrary external credential URLs from users.
      // Every auth client and ephemeral token is scoped to this invocation.
      const input = await request.json();
      const transport = createWorkersGrpcTransport(input.mode === 'cloudflare' ? { mode: 'cloudflare' } : {
        mode: 'grpc-web', endpoints: {
          'logical.fixture.invalid': 'https://gateway.fixture.invalid',
          'secretmanager.googleapis.com': 'https://gateway.fixture.invalid',
        },
      });
      const v11 = input.authVersion === '11.1.0';
      const External = v11 ? ExternalAccountClientV11 : ExternalAccountClient;
      const Identity = v11 ? IdentityPoolClientV11 : IdentityPoolClient;
      const Delegate = v11 ? ImpersonatedV11 : Impersonated;
      const OAuth = v11 ? OAuth2ClientV11 : OAuth2Client;
      const authFor = identity => {
        if (input.kind !== 'impersonated') {
          const auth = External.fromJSON(identity.credentials);
          check(auth instanceof Identity, 'IDENTITY_POOL_CLIENT');
          return auth;
        }
        const sourceClient = new OAuth();
        sourceClient.setCredentials({ access_token: identity.sourceToken, expiry_date: Date.now() + 3600000 });
        return new Delegate({ sourceClient, targetPrincipal: identity.email, delegates: identity.delegates,
          targetScopes: identity.scopes, lifetime: 900, quotaProjectId: identity.quota });
      };
      const control = async (action, index = 0) => {
        const response = await fetch(`https://control.fixture.invalid/${action}/${input.identities[index].id}`);
        check(response.ok, 'CONTROL_ENDPOINT');
        await response.text();
      };
      stage = input.scenario;
      if (input.scenario === 'sdk-credentials') {
        check(v11 && input.kind !== 'impersonated', 'SDK_AUTH_VERSION');
        // The SDK creates GoogleAuth/IdentityPoolClient from the provided JSON;
        // no authClient injection, filesystem ADC, environment credentials or metadata.
        const sdk = new SecretManagerServiceClient(transport.gaxOptions({
          projectId: 'wga-federation-fixture', credentials: input.identities[0].credentials,
        }));
        clients.push(() => sdk.close());
        const name = `projects/wga-federation-fixture/secrets/${input.identities[0].id}`;
        for (let i = 0; i < 3; i++) {
          if (i === 2) {
            const auth = await sdk.auth.getClient();
            check(auth instanceof Identity, 'SDK_IDENTITY_POOL_CLIENT');
            auth.setCredentials({ ...auth.credentials, expiry_date: Date.now() - 1000 });
          }
          const [secret] = await sdk.getSecret({ name }, { retry: null, timeout: 5000 });
          check(secret.name === name, 'SDK_RESPONSE');
        }
      } else {
        const auths = input.identities.map(authFor);
        const directClients = auths.map(auth => {
          const credentials = grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), grpc.credentials.createFromGoogleCredential(auth));
          const client = new grpc.Client('logical.fixture.invalid', credentials, transport.grpcOptions());
          clients.push(() => client.close());
          return client;
        });
        const run = (index = 0) => invoke(directClients[index], input.identities[index].id);
        if (input.scenario === 'cache-refresh') {
          await succeeded(run());
          await succeeded(run());
          auths[0].setCredentials({ ...auths[0].credentials, expiry_date: Date.now() - 1000 });
          await succeeded(run());
        } else if (input.scenario === 'concurrent-exchange') {
          const calls = Array.from({ length: 6 }, () => run());
          await control('started');
          await control('release');
          await Promise.all(calls.map(succeeded));
        } else if (input.scenario === 'isolated-exchange') {
          const left = run(0), right = run(1);
          await Promise.all([control('started', 0), control('started', 1)]);
          await control('release', 1);
          await succeeded(right);
          await control('release', 0);
          await succeeded(left);
          await Promise.all([succeeded(run(0)), succeeded(run(1))]);
        } else if (['denied-exchange', 'denied-sts'].includes(input.scenario)) {
          const denied = run();
          const { error } = await denied.settled;
          await turn();
          check(error?.code === grpc.status.INTERNAL && error.details === 'WGA_AUTH_METADATA', 'DENIED_SANITIZED');
          check(denied.callbacks() === 1 && denied.trace.join(',') === 'callback,status:13', 'DENIED_EVENT_ORDER');
          await succeeded(run());
        } else if (['cancel-exchange', 'deadline-exchange'].includes(input.scenario)) {
          const deadline = input.scenario === 'deadline-exchange';
          const stopped = invoke(directClients[0], `${input.identities[0].id}-stopped`, deadline ? 1000 : 5000);
          await control('started');
          if (!deadline) stopped.call.cancel();
          const { error } = await stopped.settled;
          const code = deadline ? grpc.status.DEADLINE_EXCEEDED : grpc.status.CANCELLED;
          check(error?.code === code, 'EXCHANGE_INTERRUPTION_CODE');
          await control('release');
          // Do not start a second refresh to observe the original completion.
          const until = Date.now() + 5000;
          while (!(auths[0].credentials.expiry_date > Date.now()) && Date.now() < until) await turn();
          check(auths[0].credentials.expiry_date > Date.now(), 'EXCHANGE_COMPLETED');
          await turn();
          check(stopped.callbacks() === 1 && stopped.trace.join(',') === `callback,status:${code}`, 'EXCHANGE_INTERRUPTION_ONCE');
          await succeeded(run());
        } else check(false, 'UNKNOWN_SCENARIO');
        for (const auth of auths) check(auth.credentials.expiry_date > Date.now(), 'CREDENTIAL_EXPIRY');
      }
      return Response.json({ status: 'passed', scenario: input.scenario, mode: input.mode, authVersion: input.authVersion });
    } catch (error) {
      // Auth/Gaxios errors may contain bearer and subject tokens. Fixed codes only.
      return Response.json({ status: 'failed', stage, diagnostic: error.fixtureDiagnostic || 'FEDERATED_AUTH_RUNTIME_FAILURE',
        errorClass: error.constructor?.name || 'Error' }, { status: 500 });
    } finally { await Promise.all(clients.map(close => close())); }
  },
};
