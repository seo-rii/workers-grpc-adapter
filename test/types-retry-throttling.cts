import { createWorkersGrpcTransport, WorkersGrpcRetryUsage } from '@grpc/grpc-js/adapter';
import { WorkersGrpcRetryThrottling, WorkersGrpcEvent } from '@grpc/grpc-js/config';
const throttle: WorkersGrpcRetryThrottling = { maxTokens: 10, tokenRatio: 0.1 };
const transport = createWorkersGrpcTransport({ retryThrottling: throttle, retryPolicy: {
    methods: ['/example.Service/Read'], maxAttempts: 3, initialBackoffMs: 10,
    maxBackoffMs: 100, retryableStatusCodes: [14],
} });
const usage: WorkersGrpcRetryUsage | undefined = transport.retryUsage('example.test');
if (usage) {
    const allowed: boolean = usage.retriesAllowed;
    // @ts-expect-error diagnostics are readonly
    usage.tokens = 100;
    void allowed;
}
const event: Extract<WorkersGrpcEvent, { type: 'retry-throttled' }> = {
    type: 'retry-throttled', logicalCallId: 'wga-1', elapsedMs: 2, attempt: 1, statusCode: 14,
};
// @ts-expect-error maxTokens must be numeric
const bad: WorkersGrpcRetryThrottling = { maxTokens: 'many', tokenRatio: 0.1 };
void [event, bad];
