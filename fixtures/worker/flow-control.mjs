import * as grpc from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { runPublicFlowSuite } from '../shared/flow-control.mjs';
import { runWireFlowSuite } from '../shared/flow-wire.mjs';
export default {
  async fetch(request, env) {
    try {
      const mode = new URL(request.url).pathname.slice(1);
      const bindings = { grpc, createWorkersGrpcTransport, target: 'flow.test', runtime: 'workerd', mode,
        fetcher: { fetch: (url, init) => env.PEER.fetch(url, init) } };
      const result = await runPublicFlowSuite(bindings);
      result.rows.push(...await runWireFlowSuite(bindings));
      return Response.json(result);
    } catch (error) {
      return Response.json({ status: 'failed', diagnostic: String(error.stack ?? error) }, { status: 500 });
    }
  },
};
