import * as grpc from '@grpc/grpc-js';
import * as adapter from '@grpc/grpc-js/adapter';
import * as config from '@grpc/grpc-js/config';
import definition from 'catalog-api-definition';
import { createApiRunner } from '../shared/catalog-api.mjs';
let run;
export default { async fetch(request, env) {
  try {
    run ??= createApiRunner(grpc, adapter, config, env.MODE, definition);
    const value = await run({ callbackThrow: new URL(request.url).pathname === '/throw' });
    return Response.json(value);
  } catch (error) { return Response.json({ status: 'failed', message: error.message, stack: error.stack }, { status: 500 }); }
} };
