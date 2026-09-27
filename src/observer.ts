import { status } from './status';

/** All counters are local observations, never proof of remote delivery. */
export interface WorkersGrpcTraffic {
    readonly sentBytes: number;
    readonly receivedBytes: number;
    readonly responseMessages: number;
    readonly responseMessageBytes: number;
}
interface EventBase {
    readonly logicalCallId: string;
    /** Monotonic milliseconds since logical call construction. */
    readonly elapsedMs: number;
}
/** No method, target, metadata, payload, or status details are collected. */
export type WorkersGrpcEvent = EventBase & (
    | { readonly type: 'call-start' }
    | { readonly type: 'call-admitted'; readonly queueMs: number }
    | { readonly type: 'attempt-start'; readonly attempt: number }
    | { readonly type: 'auth-end'; readonly attempt: number; readonly durationMs: number; readonly statusCode: status }
    | { readonly type: 'fetch-start' | 'response-headers' | 'first-message'; readonly attempt: number }
    | ({ readonly type: 'attempt-end'; readonly attempt: number; readonly durationMs: number;
        readonly authDurationMs: number; readonly fetchStarted: boolean; readonly statusCode: status } & WorkersGrpcTraffic)
    | { readonly type: 'retry-scheduled'; readonly attempt: number; readonly delayMs: number; readonly statusCode: status }
    | { readonly type: 'retry-throttled'; readonly attempt: number; readonly statusCode: status }
    | ({ readonly type: 'call-end'; readonly attemptCount: number; readonly fetchCount: number;
        readonly queueMs: number; readonly statusCode: status } & WorkersGrpcTraffic)
);
/** Invoked in microtasks; return values are observed for rejection, never awaited. */
export type WorkersGrpcObserver = (event: WorkersGrpcEvent) => void | PromiseLike<void>;

type EventInput = WorkersGrpcEvent extends infer E ? E extends EventBase ? Omit<E, keyof EventBase> : never : never;
interface Attempt {
    number: number;
    started: number;
    authDuration?: number;
    fetchStarted: boolean;
    sentBytes: number;
    receivedBytes: number;
    responseMessages: number;
    responseMessageBytes: number;
}
let nextId = 0n;
/** Internal state, created only when observation is enabled. */
export class CallObservation {
    private readonly id = `wga-${++nextId}`;
    private readonly createdAt: number;
    private elapsed = 0;
    private started = false;
    private closed = false;
    private queueStarted?: number;
    private queueMs = 0;
    private attemptCount = 0;
    private fetchCount = 0;
    private attempt?: Attempt;
    private readonly totals = { sentBytes: 0, receivedBytes: 0, responseMessages: 0, responseMessageBytes: 0 };
    constructor(private readonly observer: WorkersGrpcObserver, private readonly now = () => performance.now()) {
        this.createdAt = now();
    }
    private time(): number {
        this.elapsed = Math.max(this.elapsed, this.now() - this.createdAt, 0);
        return this.elapsed;
    }
    private emit(input: EventInput): void {
        const event = Object.freeze({ ...input, logicalCallId: this.id, elapsedMs: this.time() }) as WorkersGrpcEvent;
        const observer = this.observer;
        // Capture only primitives and the callback, not the call, buffers or SDK.
        queueMicrotask(() => {
            try { const result = observer(event); if (result !== undefined) void Promise.resolve(result).catch(() => {}); }
            catch { /* Instrumentation cannot change RPC status or cleanup. */ }
        });
    }
    start(): void {
        if (this.started) return;
        this.started = true;
        this.emit({ type: 'call-start' });
    }
    queue(): void { if (!this.closed && this.queueStarted === undefined) this.queueStarted = this.time(); }
    admitted(): void {
        if (this.closed) return;
        this.queueMs = this.queueStarted === undefined ? 0 : this.time() - this.queueStarted;
        this.queueStarted = undefined;
        this.emit({ type: 'call-admitted', queueMs: this.queueMs });
    }
    beginAttempt(): void {
        if (this.closed) return;
        this.attempt = { number: ++this.attemptCount, started: this.time(), fetchStarted: false,
            sentBytes: 0, receivedBytes: 0, responseMessages: 0, responseMessageBytes: 0 };
        this.emit({ type: 'attempt-start', attempt: this.attempt.number });
    }
    authEnd(statusCode: status): void {
        const attempt = this.attempt;
        if (this.closed || !attempt || attempt.authDuration !== undefined) return;
        attempt.authDuration = this.time() - attempt.started;
        this.emit({ type: 'auth-end', attempt: attempt.number, durationMs: attempt.authDuration, statusCode });
    }
    fetchStart(bytes: number): void {
        const attempt = this.attempt;
        if (this.closed || !attempt) return;
        attempt.fetchStarted = true;
        this.fetchCount++;
        this.sent(bytes);
        this.emit({ type: 'fetch-start', attempt: attempt.number });
    }
    headers(): void {
        if (!this.closed && this.attempt) this.emit({ type: 'response-headers', attempt: this.attempt.number });
    }
    sent(bytes: number): void {
        if (this.closed || !this.attempt) return;
        this.attempt.sentBytes += bytes; this.totals.sentBytes += bytes;
    }
    received(bytes: number): void {
        if (this.closed || !this.attempt) return;
        this.attempt.receivedBytes += bytes; this.totals.receivedBytes += bytes;
    }
    message(bytes: number): void {
        const attempt = this.attempt;
        if (this.closed || !attempt) return;
        attempt.responseMessages++; attempt.responseMessageBytes += bytes;
        this.totals.responseMessages++; this.totals.responseMessageBytes += bytes;
        if (attempt.responseMessages === 1) this.emit({ type: 'first-message', attempt: attempt.number });
    }
    endAttempt(statusCode: status): void {
        const attempt = this.attempt;
        if (this.closed || !attempt) return;
        this.authEnd(statusCode);
        this.attempt = undefined;
        this.emit({ type: 'attempt-end', attempt: attempt.number, durationMs: this.time() - attempt.started,
            authDurationMs: attempt.authDuration!, fetchStarted: attempt.fetchStarted, statusCode,
            sentBytes: attempt.sentBytes, receivedBytes: attempt.receivedBytes,
            responseMessages: attempt.responseMessages, responseMessageBytes: attempt.responseMessageBytes });
    }
    retry(attempt: number, delayMs: number, statusCode: status): void {
        if (!this.closed) this.emit({ type: 'retry-scheduled', attempt, delayMs, statusCode });
    }
    throttled(attempt: number, statusCode: status): void {
        if (!this.closed) this.emit({ type: 'retry-throttled', attempt, statusCode });
    }
    finish(statusCode: status): void {
        if (this.closed) return;
        this.start();
        this.endAttempt(statusCode);
        if (this.queueStarted !== undefined) this.queueMs = this.time() - this.queueStarted;
        this.closed = true;
        this.emit({ type: 'call-end', statusCode, attemptCount: this.attemptCount, fetchCount: this.fetchCount,
            queueMs: this.queueMs, ...this.totals });
    }
}
