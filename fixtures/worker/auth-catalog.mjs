import * as grpc from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { runAuthCatalog } from '../google/shared/auth-catalog.mjs';

export default {
  async fetch(request) {
    const { input, native } = await request.json();
    const result = await runAuthCatalog({ grpc, createWorkersGrpcTransport, input, native, runtime: 'workerd' });
    return Response.json(result, { status: result.status === 'passed' ? 200 : 500 });
  },
};
