import * as grpc from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { runLifecycleSuite } from '../shared/call-lifecycle.mjs';
let unexpected = 0, expected, sensor = 0;
// https://developers.cloudflare.com/workers/runtime-apis/web-standards/
addEventListener('unhandledrejection', event => {
  if (event.reason === expected) sensor++;
  else unexpected++;
  event.preventDefault();
});
export default {
  async fetch() {
    try {
      expected = new Error('LIFECYCLE_REJECTION_SENSOR');
      void Promise.reject(expected);
      for (let i = 0; i < 10 && sensor === 0; i++) await new Promise(resolve => setTimeout(resolve, 0));
      if (sensor !== 1) throw new Error('LIFECYCLE_REJECTION_SENSOR_MISSING');
      const result = await runLifecycleSuite({ grpc, createWorkersGrpcTransport, unhandled: () => unexpected }, 'workerd');
      return Response.json({ ...result, rejectionSensorCount: sensor });
    } catch (error) { return Response.json({ status: 'failed', diagnostic: String(error.message), stack: error.stack }, { status: 500 }); }
  },
};
