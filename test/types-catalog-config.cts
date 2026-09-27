import { configureWorkersGrpc, getWorkersGrpcConfig, type WorkersGrpcConfig } from '@grpc/grpc-js/config';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
const valid: WorkersGrpcConfig = { mode: 'grpc-web', endpoints: { 'example.test': 'https://gateway.test' }, defaultTimeoutMs: 1000 };
configureWorkersGrpc(valid);
createWorkersGrpcTransport({ mode: 'cloudflare' });
const snapshot = getWorkersGrpcConfig();
// @ts-expect-error catalog-negative:missing-mode
configureWorkersGrpc({ endpoints: { 'example.test': 'https://gateway.test' } });
// @ts-expect-error catalog-negative:missing-mapping
configureWorkersGrpc({ mode: 'grpc-web' });
// @ts-expect-error catalog-negative:numeric-timeout
configureWorkersGrpc({ defaultTimeoutMs: '1000' });
// @ts-expect-error catalog-negative:numeric-send
configureWorkersGrpc({ transportMaxSendBytes: '1000' });
// @ts-expect-error catalog-negative:numeric-receive
configureWorkersGrpc({ transportMaxReceiveBytes: '1000' });
// @ts-expect-error catalog-negative:readonly-mode
snapshot.mode = 'grpc-web';
// @ts-expect-error catalog-negative:readonly-timeout
snapshot.defaultTimeoutMs = 1000;
// @ts-expect-error catalog-negative:readonly-mapping
snapshot.endpoints['example.test'] = 'https://other.test';
// @ts-expect-error catalog-negative:readonly-resources
snapshot.resourceLimits.maxConcurrentCalls = 1;
// @ts-expect-error catalog-negative:cloudflare-mapping
configureWorkersGrpc({ mode: 'cloudflare', endpoints: {} });
