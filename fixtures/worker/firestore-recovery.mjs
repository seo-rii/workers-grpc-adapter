import { credentials } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { runFirestoreRecovery } from '../google/shared/firestore-recovery.mjs';

export default {
    async fetch(request, env) {
        if (env.PROJECT_ID !== 'demo-wga-local' || !/^127\.0\.0\.1:\d+$/.test(env.ENDPOINT)) throw new Error('WATCH_LOCAL_BINDINGS');
        try {
            const transport = createWorkersGrpcTransport({ mode: 'grpc-web', experimentalRequestStreaming: true,
                allowInsecureLocalhost: true, endpoints: { [env.ENDPOINT]: `http://${env.ENDPOINT}` } });
            const options = transport.gaxOptions({ projectId: env.PROJECT_ID, host: env.ENDPOINT });
            options.sslCreds = credentials.createInsecure();
            const result = await runFirestoreRecovery({ options, scenario: new URL(request.url).pathname.slice(1),
                advance: async () => {
                    const response = await fetch(`http://${env.ENDPOINT}/__advance`, { method: 'POST' });
                    if (response.status !== 204) throw new Error('WATCH_CONTROL_FAILED');
                } });
            return Response.json({ status: 'passed', ...result });
        } catch (error) {
            return Response.json({ status: 'failed', diagnostic: error.fixtureDiagnostic ?? 'WATCH_SDK_FAILURE',
                errorClass: error.constructor?.name ?? 'Error', code: error.code ?? null }, { status: 500 });
        }
    },
};
