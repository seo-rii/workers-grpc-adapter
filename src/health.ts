import { Buffer } from 'node:buffer';
import { Client, CallOptions, Deadline } from './client';
import { ClientReadableStream, ClientUnaryCall, ServiceError } from './call-surface';
import { Metadata } from './metadata';
import { status } from './status';

/** Application health reported by grpc.health.v1; not connection readiness. */
export enum HealthServingStatus { UNKNOWN = 0, SERVING = 1, NOT_SERVING = 2, SERVICE_UNKNOWN = 3 }
/** Unknown future enum values are preserved, and never interpreted as SERVING. */
export interface HealthCheckResponse { status: number }
export interface HealthCallOptions extends CallOptions { metadata?: Metadata; signal?: AbortSignal }
export interface HealthWatchOptions extends Omit<HealthCallOptions, 'deadline' | 'signal'> {
    initialBackoffMs?: number;
    maxBackoffMs?: number;
    backoffMultiplier?: number;
    /** A fractional random variation in [0, 1]; default 0.2. */
    backoffJitter?: number;
    /** Optional timeout for each Watch attempt; no timeout by default. */
    attemptTimeoutMs?: number;
}
export interface HealthWaitOptions { deadline: Deadline; signal?: AbortSignal }
export interface HealthWatchState {
    readonly phase: 'connecting' | 'serving' | 'not-serving' | 'reconnecting' | 'disabled' | 'closed';
    readonly servingStatus: number | null;
    readonly attempt: number;
    readonly lastErrorCode: number | null;
}
const maxTimerMs = 2147483647;
function healthError(code: status, details: string): ServiceError {
    return Object.assign(new Error(details), { code, details, metadata: new Metadata() });
}
function requireNumber(value: number, min: number, max: number, id: string): number {
    if (!Number.isFinite(value) || value < min || value > max) throw healthError(status.INVALID_ARGUMENT, id);
    return value;
}
function deadlineTime(value: Deadline): number {
    const time = value instanceof Date ? value.getTime() : value;
    return requireNumber(time, 0, Number.MAX_SAFE_INTEGER, 'WGA_HEALTH_INVALID_DEADLINE');
}
function encodeRequest(service: string): Buffer {
    if (typeof service !== 'string') throw healthError(status.INVALID_ARGUMENT, 'WGA_HEALTH_INVALID_SERVICE');
    if (service === '') return Buffer.alloc(0);
    const bytes = Buffer.from(service, 'utf8');
    let length = bytes.length;
    const prefix = [10];
    do { const low = length % 128; length = Math.floor(length / 128); prefix.push(low | (length ? 128 : 0)); } while (length);
    return Buffer.concat([Buffer.from(prefix), bytes]);
}
function decodeResponse(bytes: Buffer): HealthCheckResponse {
    let offset = 0, serving = 0;
    const groups: number[] = [];
    const malformed = () => healthError(status.INTERNAL, 'WGA_HEALTH_INVALID_PROTOBUF');
    function varint(): bigint {
        let value = 0n;
        for (let index = 0; index < 10; index++) {
            if (offset >= bytes.length) throw malformed();
            const byte = bytes[offset++];
            if (index === 9 && byte > 1) throw malformed();
            value |= BigInt(byte & 127) << BigInt(index * 7);
            if (!(byte & 128)) return value;
        }
        throw malformed();
    }
    while (offset < bytes.length) {
        const tag = varint();
        if (tag > 0xffffffffn || tag < 8n) throw malformed();
        const field = Number(tag >> 3n), wire = Number(tag & 7n);
        if (field === 1 && groups.length === 0) {
            if (wire !== 0) throw malformed();
            serving = Number(BigInt.asIntN(32, varint()));
            continue;
        }
        let skip = 0;
        switch (wire) {
            case 0: varint(); break;
            case 1: skip = 8; break;
            case 2: {
                const length = varint();
                if (length > BigInt(bytes.length - offset)) throw malformed();
                skip = Number(length); break;
            }
            case 3:
                if (groups.length >= 64) throw malformed();
                groups.push(field); break;
            case 4:
                if (groups.pop() !== field) throw malformed();
                break;
            case 5: skip = 4; break;
            default: throw malformed();
        }
        if (skip > bytes.length - offset) throw malformed();
        offset += skip;
    }
    if (groups.length !== 0) throw malformed();
    return { status: serving };
}

/** Reuses an existing adapter Client's routing, credentials and interceptors. */
export class HealthClient {
    constructor(private readonly client: Client) {}
    check(service = '', options: HealthCallOptions = {}): Promise<HealthCheckResponse> {
        return new Promise((resolve, reject) => {
            let call: ClientUnaryCall | undefined, finished = false;
            const { signal, metadata, ...callOptions } = options;
            const finish = (error: Error | null, value?: HealthCheckResponse) => {
                if (finished) return;
                finished = true;
                signal?.removeEventListener('abort', abort);
                if (error) reject(error); else resolve(value!);
            };
            const abort = () => {
                finish(healthError(status.CANCELLED, 'WGA_HEALTH_ABORTED'));
                call?.cancel();
            };
            if (signal?.aborted) { abort(); return; }
            try {
                // Explicit health probes are bounded even when the channel has
                // no default timeout; callers can select their own deadline.
                callOptions.deadline = deadlineTime(callOptions.deadline ?? Date.now() + 5000);
                if (callOptions.deadline <= Date.now()) {
                    finish(healthError(status.DEADLINE_EXCEEDED, 'WGA_HEALTH_DEADLINE_EXCEEDED')); return;
                }
                encodeRequest(service);
                signal?.addEventListener('abort', abort, { once: true });
                call = this.client.makeUnaryRequest('/grpc.health.v1.Health/Check', encodeRequest, decodeResponse,
                    service, metadata?.clone() ?? new Metadata(), callOptions, finish);
                if (signal?.aborted) abort();
            } catch (error) { finish(error as Error); }
        });
    }
    /** One raw Watch call. The caller owns cancellation and stream listeners. */
    watch(service = '', options: Omit<HealthCallOptions, 'signal'> = {}): ClientReadableStream<HealthCheckResponse> {
        encodeRequest(service);
        const { metadata, ...callOptions } = options;
        return this.client.makeServerStreamRequest('/grpc.health.v1.Health/Watch', encodeRequest, decodeResponse,
            service, metadata?.clone() ?? new Metadata(), callOptions);
    }
    /** Starts a managed Watch without taking ownership of the underlying client. */
    monitor(service = '', options: HealthWatchOptions = {}): HealthWatch {
        return new HealthWatch(this, service, options);
    }
}

/** Reconnecting application-health observer. Close it within the Worker lifetime. */
export class HealthWatch {
    private state: HealthWatchState = Object.freeze({ phase: 'connecting', servingStatus: null, attempt: 0, lastErrorCode: null });
    private stream?: ClientReadableStream<HealthCheckResponse>;
    private retryTimer?: ReturnType<typeof setTimeout>;
    private nextDelay: number;
    private readonly initialDelay: number;
    private readonly maxDelay: number;
    private readonly multiplier: number;
    private readonly jitter: number;
    private readonly attemptTimeout?: number;
    private readonly callOptions: Omit<HealthCallOptions, 'signal'>;
    private readonly waiters = new Set<(error?: ServiceError) => void>();
    constructor(private readonly client: HealthClient, private readonly service = '', options: HealthWatchOptions = {}) {
        encodeRequest(service);
        const { initialBackoffMs = 1000, maxBackoffMs = 30000, backoffMultiplier = 1.6, backoffJitter = 0.2,
            attemptTimeoutMs, metadata, ...callOptions } = options;
        this.initialDelay = requireNumber(initialBackoffMs, 1, maxTimerMs, 'WGA_HEALTH_INVALID_BACKOFF');
        this.maxDelay = requireNumber(maxBackoffMs, this.initialDelay, maxTimerMs, 'WGA_HEALTH_INVALID_BACKOFF');
        this.multiplier = requireNumber(backoffMultiplier, 1, 100, 'WGA_HEALTH_INVALID_BACKOFF');
        this.jitter = requireNumber(backoffJitter, 0, 1, 'WGA_HEALTH_INVALID_BACKOFF');
        this.attemptTimeout = attemptTimeoutMs === undefined ? undefined
            : requireNumber(attemptTimeoutMs, 1, maxTimerMs, 'WGA_HEALTH_INVALID_ATTEMPT_TIMEOUT');
        this.callOptions = { ...callOptions, metadata: metadata?.clone() };
        this.nextDelay = this.initialDelay;
        queueMicrotask(() => this.start());
    }
    getState(): HealthWatchState { return this.state; }
    private setState(next: HealthWatchState): void {
        this.state = Object.freeze(next);
        if (next.phase === 'serving') for (const finish of [...this.waiters]) finish();
        else if (next.phase === 'disabled') for (const finish of [...this.waiters]) {
            finish(healthError(status.UNIMPLEMENTED, 'WGA_HEALTH_WATCH_UNIMPLEMENTED'));
        }
    }
    private start(): void {
        if (this.state.phase === 'closed' || this.state.phase === 'disabled') return;
        this.retryTimer = undefined;
        this.setState({ phase: 'connecting', servingStatus: null, attempt: this.state.attempt + 1, lastErrorCode: this.state.lastErrorCode });
        let stream: ClientReadableStream<HealthCheckResponse>;
        try {
            stream = this.client.watch(this.service, { ...this.callOptions,
                ...(this.attemptTimeout === undefined ? {} : { deadline: Date.now() + this.attemptTimeout }) });
        } catch {
            this.complete(status.UNKNOWN); return;
        }
        this.stream = stream;
        stream.on('data', (response: HealthCheckResponse) => {
            if (this.stream !== stream || this.state.phase === 'closed') return;
            this.nextDelay = this.initialDelay;
            this.setState({ phase: response.status === HealthServingStatus.SERVING ? 'serving' : 'not-serving',
                servingStatus: response.status, attempt: this.state.attempt, lastErrorCode: null });
        });
        // grpc-js emits error before the terminal status. Keep an error listener
        // installed through cancellation; retry exactly once from status.
        stream.on('error', () => {});
        stream.once('status', result => {
            if (this.stream !== stream) return;
            this.stream = undefined;
            this.complete(result.code);
        });
    }
    private complete(code: number): void {
        if (this.state.phase === 'closed') return;
        if (code === status.UNIMPLEMENTED) {
            this.setState({ phase: 'disabled', servingStatus: null, attempt: this.state.attempt, lastErrorCode: code });
            return;
        }
        this.setState({ phase: 'reconnecting', servingStatus: null, attempt: this.state.attempt, lastErrorCode: code });
        // Every server terminal status, including OK, is retried by the standard
        // Watch protocol. Auth failures therefore also require caller lifetime control.
        const delay = Math.min(this.maxDelay, Math.max(1, this.nextDelay * (1 + this.jitter * (2 * Math.random() - 1))));
        this.nextDelay = Math.min(this.maxDelay, this.nextDelay * this.multiplier);
        this.retryTimer = setTimeout(() => this.start(), delay);
    }
    waitForServing(options: HealthWaitOptions): Promise<HealthWatchState> {
        return new Promise((resolve, reject) => {
            let deadline: number;
            try { deadline = deadlineTime(options.deadline); } catch (error) { reject(error); return; }
            const { signal } = options;
            if (signal?.aborted) { reject(healthError(status.CANCELLED, 'WGA_HEALTH_ABORTED')); return; }
            if (deadline <= Date.now()) { reject(healthError(status.DEADLINE_EXCEEDED, 'WGA_HEALTH_DEADLINE_EXCEEDED')); return; }
            if (this.state.phase === 'closed') { reject(healthError(status.CANCELLED, 'WGA_HEALTH_WATCH_CLOSED')); return; }
            if (this.state.phase === 'disabled') { reject(healthError(status.UNIMPLEMENTED, 'WGA_HEALTH_WATCH_UNIMPLEMENTED')); return; }
            if (this.state.phase === 'serving') { resolve(this.state); return; }
            let timer: ReturnType<typeof setTimeout> | undefined;
            let done = false;
            const finish = (error?: ServiceError) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                this.waiters.delete(finish);
                if (error) reject(error); else resolve(this.state);
            };
            const abort = () => finish(healthError(status.CANCELLED, 'WGA_HEALTH_ABORTED'));
            const tick = () => {
                const left = deadline - Date.now();
                if (left <= 0) finish(healthError(status.DEADLINE_EXCEEDED, 'WGA_HEALTH_DEADLINE_EXCEEDED'));
                else timer = setTimeout(tick, Math.min(left, maxTimerMs));
            };
            this.waiters.add(finish);
            signal?.addEventListener('abort', abort, { once: true });
            tick();
        });
    }
    /** Cancels this observer only. The wrapped Client remains reusable. */
    close(): void {
        if (this.state.phase === 'closed') return;
        this.setState({ phase: 'closed', servingStatus: null, attempt: this.state.attempt, lastErrorCode: this.state.lastErrorCode });
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        const stream = this.stream;
        this.stream = undefined;
        for (const finish of [...this.waiters]) finish(healthError(status.CANCELLED, 'WGA_HEALTH_WATCH_CLOSED'));
        stream?.cancel();
    }
}
