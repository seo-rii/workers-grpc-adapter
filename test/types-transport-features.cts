import {
    Client, ClientReadableStream, credentials, HealthCallOptions, HealthCheckResponse,
    HealthClient, HealthServingStatus, HealthWaitOptions, HealthWatch, HealthWatchOptions,
    HealthWatchState, Metadata, status,
} from '@grpc/grpc-js';
import {
    configureWorkersGrpc, getWorkersGrpcConfig, WorkersGrpcConfig, WorkersGrpcConfigSnapshot,
    WorkersGrpcFetcher, WorkersGrpcRetryPolicy,
} from '@grpc/grpc-js/config';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

// A binding object is passed intact: its public method uses the platform Fetch API.
class ServiceBinding {
    constructor(readonly origin: string) {}
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const request = new Request(input, init);
        return fetch(new URL(new URL(request.url).pathname, this.origin), request);
    }
}
const binding: WorkersGrpcFetcher = new ServiceBinding('https://gateway.example');
const methods: readonly string[] = ['/example.Catalog/Get'];
const codes: readonly status[] = [status.UNAVAILABLE, status.RESOURCE_EXHAUSTED];
const retry: WorkersGrpcRetryPolicy = {
    methods, maxAttempts: 3, initialBackoffMs: 100, maxBackoffMs: 1000,
    backoffMultiplier: 2, retryableStatusCodes: codes, retryOnFetchError: false,
};
const config: WorkersGrpcConfig = {
    mode: 'grpc-web', endpoints: { 'catalog.example': 'https://gateway.example' },
    fetcher: binding, retryPolicy: retry, defaultTimeoutMs: 5000,
};
const snapshot: WorkersGrpcConfigSnapshot = configureWorkersGrpc(config);
const saved: WorkersGrpcConfigSnapshot = getWorkersGrpcConfig();
const automatic: WorkersGrpcConfig = { mode: 'cloudflare', fetcher: binding, retryPolicy: retry };
const transport = createWorkersGrpcTransport(config);
const client = new Client('catalog.example', credentials.createSsl(), transport.grpcOptions());
const sdkOptions = transport.gaxOptions({ projectId: 'type-fixture' });
const project: string = sdkOptions.projectId;
const fallback: false = sdkOptions.fallback;
const retryAttempts: number | undefined = saved.retryPolicy?.maxAttempts;
const response: Promise<Response> | undefined = snapshot.fetcher?.fetch(new URL('https://catalog.example'));
// @ts-expect-error snapshots cannot change selected routing after client construction
snapshot.fetcher = binding;
// @ts-expect-error retry snapshots cannot change replay safety after construction
snapshot.retryPolicy?.methods.push('/example.Catalog/Write');
// @ts-expect-error Fetcher must return a Response asynchronously
const badFetcher: WorkersGrpcFetcher = { fetch() { return new Response(); } };
// @ts-expect-error Fetcher must be a binding-shaped object, not a bare function
createWorkersGrpcTransport({ fetcher: fetch });
// @ts-expect-error gRPC status identifiers use enum values rather than text names
const badRetry: WorkersGrpcRetryPolicy = { ...retry, retryableStatusCodes: ['UNAVAILABLE'] };
// @ts-expect-error each selected retry method is a string
const badMethod: WorkersGrpcRetryPolicy = { ...retry, methods: [42] };
// @ts-expect-error explicit retry policies must provide the bounded attempt budget
const missingAttempts: WorkersGrpcRetryPolicy = { methods, retryableStatusCodes: codes, initialBackoffMs: 10, maxBackoffMs: 100 };
// @ts-expect-error custom Fetchers do not permit gateway endpoints in automatic mode
createWorkersGrpcTransport({ mode: 'cloudflare', fetcher: binding, endpoints: { 'catalog.example': 'https://gateway.example' } });

const controller = new AbortController();
const metadata = new Metadata();
metadata.set('x-tenant', 'type-fixture');
const health = new HealthClient(client);
const checkOptions: HealthCallOptions = { metadata, deadline: new Date(), signal: controller.signal };
const check: Promise<HealthCheckResponse> = health.check('example.Catalog', checkOptions);
const stream: ClientReadableStream<HealthCheckResponse> = health.watch('example.Catalog', { metadata, deadline: Date.now() + 5000 });
stream.on('data', (value: HealthCheckResponse) => {
    // Unknown future status values remain numbers; callers select SERVING explicitly.
    const code: number = value.status;
    const ready: boolean = code === HealthServingStatus.SERVING;
    void ready;
});
stream.on('error', (error: Error) => void error);
stream.cancel();
const monitorOptions: HealthWatchOptions = {
    metadata, initialBackoffMs: 100, maxBackoffMs: 1000,
    backoffMultiplier: 2, backoffJitter: 0.2, attemptTimeoutMs: 5000,
};
const monitor: HealthWatch = health.monitor('example.Catalog', monitorOptions);
const waitOptions: HealthWaitOptions = { deadline: Date.now() + 1000, signal: controller.signal };
const serving: Promise<HealthWatchState> = monitor.waitForServing(waitOptions);
const state: HealthWatchState = monitor.getState();
const phase: 'connecting' | 'serving' | 'not-serving' | 'reconnecting' | 'disabled' | 'closed' = state.phase;
const servingCode: number | null = state.servingStatus;
monitor.close();
// @ts-expect-error health requires an existing gRPC client with its selected transport
new HealthClient(transport);
// @ts-expect-error raw Watch cancellation belongs to the returned stream
health.watch('', { signal: controller.signal });
// @ts-expect-error managed Watch uses per-attempt timeouts and individual wait deadlines
health.monitor('', { deadline: new Date() });
// @ts-expect-error every serving wait must have a deadline
monitor.waitForServing({ signal: controller.signal });
// @ts-expect-error observed health state is immutable
state.phase = 'serving';
// @ts-expect-error check responses preserve numeric protobuf status values
const badHealthResponse: HealthCheckResponse = { status: 'SERVING' };

void [automatic, project, fallback, retryAttempts, response, badFetcher, badRetry, badMethod,
    missingAttempts, check, serving, phase, servingCode, badHealthResponse];
