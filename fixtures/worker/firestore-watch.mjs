import { credentials } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

// Local-only Miniflare fixture. Every listener is closed before the response.
export default {
    async fetch(request, env) {
        const scenario = new URL(request.url).pathname.slice(1);
        if (env.PROJECT_ID !== 'demo-wga-local' || !/^127\.0\.0\.1:\d+$/.test(env.ENDPOINT)) throw new Error('WATCH_LOCAL_BINDINGS');
        try {
            const { runFirestoreWatch } = await import('../google/shared/firestore-watch.mjs');
            const transport = createWorkersGrpcTransport({ mode: 'grpc-web', experimentalRequestStreaming: true,
                allowInsecureLocalhost: true, endpoints: { [env.ENDPOINT]: `http://${env.ENDPOINT}` } });
            const options = transport.gaxOptions({ projectId: env.PROJECT_ID, host: env.ENDPOINT });
            options.sslCreds = credentials.createInsecure();
            const result = await runFirestoreWatch({ options, scenario, runId: new URL(request.url).searchParams.get('run') });
            return Response.json({ status: 'passed', ...result });
        } catch (error) {
            return Response.json({ status: 'failed', diagnostic: error.fixtureDiagnostic ?? 'WATCH_SDK_FAILURE',
                errorClass: error.constructor?.name ?? 'Error', code: error.code ?? null }, { status: 500 });
        }
    },
};
