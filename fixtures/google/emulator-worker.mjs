import { credentials } from '@grpc/grpc-js';
import { configureWorkersGrpc } from '@grpc/grpc-js/config';
import { emulatorSuites } from './shared/emulator-suites.mjs';

// Local-only Miniflare entry, never deployed or exposed as a cloud test endpoint.
export default {
    async fetch(request, env) {
        const suite = emulatorSuites.find(item => item.suite === new URL(request.url).pathname.slice(1));
        if (!suite) return new Response('Unknown emulator suite', { status: 404 });
        if (env.PROJECT_ID !== 'demo-wga-local' || !/^127\.0\.0\.1:\d+$/.test(env.ENDPOINT)) throw new Error('Invalid local emulator binding');
        configureWorkersGrpc({ mode: 'grpc-web', allowInsecureLocalhost: true, defaultTimeoutMs: 30000, endpoints: { [env.ENDPOINT]: `http://${env.ENDPOINT}` } });
        const options = { projectId: env.PROJECT_ID, sslCreds: credentials.createInsecure() };
        if (suite.sdk === '@google-cloud/datastore') options.apiEndpoint = env.ENDPOINT;
        else options.host = env.ENDPOINT;
        try {
            const checks = await suite.run({ options, allowedProjectId: env.PROJECT_ID, allowWrites: true, runId: env.RUN_ID });
            return Response.json({ suite: suite.suite, sdk: suite.sdk, status: 'passed', checks });
        } catch (error) {
            const details = value => ({ code: value.code ?? null, class: value.constructor?.name || 'Error', message: value.message });
            return Response.json({ suite: suite.suite, sdk: suite.sdk, status: 'failed', error: { ...details(error), ...(Array.isArray(error.errors) ? { errors: error.errors.map(details) } : {}) } }, { status: 500 });
        }
    },
};
