import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { runFirestoreReadErrors, observeReadCalls, safeReadError } from '../google/shared/firestore-read-errors.mjs';

export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1);
    const events = [];
    const transport = createWorkersGrpcTransport({ observer: event => events.push(event),
      ...(env.MODE === 'cloudflare' ? { mode: 'cloudflare' } : { mode: 'grpc-web',
        endpoints: { 'firestore.googleapis.com': 'https://firestore-read-gateway.invalid' } }),
    });
    try {
      let observer;
      const result = await runFirestoreReadErrors({
        options: transport.gaxOptions({ projectId: 'demo-wga-read-errors' }), scenario,
        caseId: `${env.PROFILE}/workerd-${env.MODE}/${scenario}`,
        advanceProgress: async () => {
          const response = await fetch('https://firestore-read-control.invalid/progress', { method: 'POST',
            headers: { 'x-wga-case': `${env.PROFILE}/workerd-${env.MODE}/${scenario}` } });
          if (response.status !== 204) throw Object.assign(new Error('READ_PROGRESS_CONTROL'), { fixtureDiagnostic: 'READ_PROGRESS_CONTROL' });
        },
        beforeTerminate: async () => { observer = await observeReadCalls(events, transport); },
      });
      return Response.json({ status: 'passed', result, observer });
    } catch (error) { return Response.json({ status: 'failed', diagnostic: safeReadError(error) }, { status: 500 }); }
  },
};
