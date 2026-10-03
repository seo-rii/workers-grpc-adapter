import * as grpc from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { runWireCatalog } from '../shared/wire-harness.mjs';
export default {
  async fetch(request) {
    try {
      return Response.json(await runWireCatalog({ grpc, createWorkersGrpcTransport, runtime: 'workerd', mode: new URL(request.url).pathname.slice(1) }));
    } catch (error) { return Response.json({ status: 'failed', diagnostic: String(error.stack ?? error) }, { status: 500 }); }
  },
};
