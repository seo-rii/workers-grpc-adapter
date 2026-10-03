import * as grpc from '@grpc/grpc-js';
import { configureWorkersGrpc } from '@grpc/grpc-js/config';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { OAuth2Client } from 'google-auth-library';
import { emulatorSuites } from './shared/emulator-suites.mjs';
import { startSdkCallAccounting } from './shared/sdk-call-accounting.mjs';

// Local-only Miniflare entry, never deployed or exposed as a cloud test endpoint.
export default {
    async fetch(request, env) {
        const suite = emulatorSuites.find(item => item.suite === new URL(request.url).pathname.slice(1));
        if (!suite) return new Response('Unknown emulator suite', { status: 404 });
        if (env.PROJECT_ID !== 'demo-wga-local' || !/^127\.0\.0\.1:\d+$/.test(env.ENDPOINT)) throw new Error('Invalid local emulator binding');
        const config = { mode: 'grpc-web', allowInsecureLocalhost: true, defaultTimeoutMs: 30000, endpoints: { [env.ENDPOINT]: `http://${env.ENDPOINT}` } };
        configureWorkersGrpc(config);
        const isDatastore = suite.sdk === '@google-cloud/datastore', clients = [];
        const tracker = isDatastore ? startSdkCallAccounting(grpc) : null;
        let dataFetches = 0, authMetadataRequests = 0, authNetworkRequests = 0, result;
        try {
            let options = { projectId: env.PROJECT_ID, sslCreds: grpc.credentials.createInsecure() };
            if (isDatastore) options.apiEndpoint = env.ENDPOINT;
            else options.host = env.ENDPOINT;
            let transport;
            if (tracker) {
                const authClient = new OAuth2Client();
                // Insecure emulator channels must never request credentials.
                // These guards also prevent a regression from contacting ADC/OAuth.
                authClient.getRequestHeaders = async () => { authMetadataRequests++; throw new Error('emulator-auth-disabled'); };
                authClient.transporter.request = async () => { authNetworkRequests++; throw new Error('emulator-auth-network-disabled'); };
                transport = createWorkersGrpcTransport({ ...config, observer: tracker.observer,
                    fetcher: { fetch: tracker.wrapFetcher((url, init) => { dataFetches++; return fetch(url, init); }) } });
                const { sslCreds, ...gaxOptions } = options;
                // Emulator-only anonymous loopback channel, with the per-instance token.
                options = { ...transport.gaxOptions({ ...gaxOptions, authClient }), sslCreds };
            }
            const checks = await suite.run({ options, allowedProjectId: env.PROJECT_ID, allowWrites: true, runId: env.RUN_ID,
                registerDatastoreClient: client => clients.push(client) });
            const accounting = tracker ? await tracker.snapshot(transport) : null;
            if (isDatastore && (!clients.length || authMetadataRequests || authNetworkRequests)) throw new Error('emulator-anonymous-client-contract');
            result = { suite: suite.suite, sdk: suite.sdk, status: 'passed', checks,
                ...(isDatastore ? { accounting, dataFetches, authFetches: 0, authMetadataRequests, authNetworkRequests,
                    controlRequests: 0, authMode: 'disabled-insecure-loopback', registeredClients: clients.length } : {}) };
        } catch (error) {
            const details = value => ({ code: value.code ?? null, class: value.constructor?.name || 'Error', message: value.message });
            result = { suite: suite.suite, sdk: suite.sdk, status: 'failed', error: { ...details(error), ...(Array.isArray(error.errors) ? { errors: error.errors.map(details) } : {}) } };
        } finally {
            try {
                const generated = [...new Set(clients.flatMap(client => typeof client.close === 'function' ? [client] : [...client.clients_.values()]))];
                const closed = await Promise.allSettled(generated.map(client => client.close()));
                const failures = closed.filter(item => item.status === 'rejected').map(item => item.reason);
                if (failures.length) throw new AggregateError(failures, 'emulator-sdk-close-failed');
                if (isDatastore) result.clientsClosed = clients.length;
            } catch (error) {
                result = { suite: suite.suite, sdk: suite.sdk, status: 'failed', error: { message: error.message } };
            } finally { tracker?.restore(); }
        }
        return Response.json(result, { status: result.status === 'passed' ? 200 : 500 });
    },
};
