import { status } from '@grpc/grpc-js';
import {
    configureWorkersGrpc, WorkersGrpcConfig, WorkersGrpcConfigSnapshot,
    WorkersGrpcObserver, WorkersGrpcEvent, WorkersGrpcTraffic,
} from '@grpc/grpc-js/config';
import {
    createWorkersGrpcTransport,
    WorkersGrpcObserver as AdapterObserver,
    WorkersGrpcEvent as AdapterEvent,
    WorkersGrpcTraffic as AdapterTraffic,
} from '@grpc/grpc-js/adapter';

const events: WorkersGrpcEvent[] = [];
const observer: WorkersGrpcObserver = event => {
    events.push(event);
    const id: string = event.logicalCallId;
    const elapsed: number = event.elapsedMs;
    if (event.type === 'call-end') {
        const code: status = event.statusCode;
        const numbers: number[] = [event.attemptCount, event.fetchCount, event.queueMs,
            event.sentBytes, event.receivedBytes, event.responseMessages, event.responseMessageBytes];
        const traffic: WorkersGrpcTraffic = event;
        const adapterTraffic: AdapterTraffic = traffic;
        // @ts-expect-error observer data is immutable
        event.statusCode = status.OK;
        // @ts-expect-error logical call completion has a count, not an attempt index
        const wrongAttempt: number = event.attempt;
        void [code, numbers, adapterTraffic, wrongAttempt];
    } else if (event.type === 'attempt-end') {
        const count: number = event.attempt;
        const durations: number[] = [event.durationMs, event.authDurationMs];
        const started: boolean = event.fetchStarted;
        const traffic: AdapterTraffic = event;
        // @ts-expect-error attempt completion does not expose logical queue time
        const queue: number = event.queueMs;
        void [count, durations, started, traffic, queue];
    } else if (event.type === 'retry-scheduled') {
        const attempt: number = event.attempt;
        const delay: number = event.delayMs;
        const code: status = event.statusCode;
        void [attempt, delay, code];
    } else if (event.type === 'auth-end') {
        const duration: number = event.durationMs;
        const code: status = event.statusCode;
        void [duration, code];
    } else if (event.type === 'call-admitted') {
        const queue: number = event.queueMs;
        void queue;
    } else if (event.type !== 'call-start') {
        const attempt: number = event.attempt;
        void attempt;
    }
    // @ts-expect-error common event fields cannot be changed by consumers
    event.logicalCallId = 'replacement';
    // @ts-expect-error observation deliberately omits metadata
    const metadata = event.metadata;
    // @ts-expect-error observation deliberately omits status details
    const details = event.details;
    // @ts-expect-error observation deliberately omits method paths
    const path = event.path;
    void [id, elapsed, metadata, details, path];
};
const compatible: AdapterObserver = observer;
const firstEvent: AdapterEvent | undefined = events[0];
const asyncObserver: WorkersGrpcObserver = async event => { void event; };
const config: WorkersGrpcConfig = { observer: compatible };
const snapshot: WorkersGrpcConfigSnapshot = configureWorkersGrpc(config);
const saved: WorkersGrpcObserver | undefined = snapshot.observer;
const transport = createWorkersGrpcTransport({ observer: asyncObserver });
// @ts-expect-error configuration snapshots cannot swap observer identity
snapshot.observer = observer;
// @ts-expect-error observer must be callable
createWorkersGrpcTransport({ observer: { emit() {} } });
// @ts-expect-error observer result can only be void or a thenable of void
const wrongResult: WorkersGrpcObserver = () => 1;
// @ts-expect-error async observer result must not return a payload
const wrongAsyncResult: WorkersGrpcObserver = async () => 'payload';
const wrongCode: Extract<WorkersGrpcEvent, { type: 'auth-end' }> = {
    type: 'auth-end', logicalCallId: 'id', elapsedMs: 0, attempt: 1, durationMs: 0,
    // @ts-expect-error arbitrary string status codes do not match gRPC status enums
    statusCode: 'OK',
};
void [firstEvent, saved, transport, wrongResult, wrongAsyncResult, wrongCode];
