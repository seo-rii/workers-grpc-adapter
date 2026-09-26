import { Buffer } from 'node:buffer';
import { Metadata } from './metadata';
import { CallCredentials, ChannelCredentials } from './credentials';
import { status, authErrorCode, TransportError, httpStatusToGrpc } from './status';
import { WorkersGrpcConfigSnapshot, normalizeAuthority } from './config-internal';
import { ValidatedOptions } from './options';
import { StatusObject, decodeFrames, encodeFrame, metadataFromHeaders, parseTrailers, requestHeaders, statusFromHeaders } from './wire';
import type { Interceptor, InterceptorProvider } from './client-interceptors';
export type Deadline = Date | number;
export interface CallOptions {
    deadline?: Deadline;
    credentials?: CallCredentials;
    host?: string;
    parent?: unknown;
    propagate_flags?: number;
    interceptors?: Interceptor[];
    interceptor_providers?: InterceptorProvider[];
}
export interface CallListener {
    onReceiveMetadata(metadata: Metadata): void;
    onReceiveMessage(message: Buffer): void;
    onReceiveStatus(result: StatusObject): void;
}
export interface CallContext {
    path: string;
    requestStream: boolean;
    responseStream: boolean;
    options: CallOptions;
    authority: string;
    origin: string;
    insecure: boolean;
    credentials: ChannelCredentials;
    config: WorkersGrpcConfigSnapshot;
    limits: ValidatedOptions;
    onFinish: () => void;
    closed: boolean;
}
/** Invoke observers outside the transport error model, after updating state. */
function notify(fn: () => void): void {
    try {
        fn();
    }
    catch (error) {
        queueMicrotask(() => {
            throw error;
        });
    }
}
export class WorkersCall {
    private listener?: CallListener;
    private metadata?: Metadata;
    private request?: Buffer;
    private halfClosed = false;
    private started = false;
    private fetching = false;
    private authReady = false;
    private readDemand = false;
    private wakeRead?: () => void;
    private terminal?: StatusObject;
    private terminalDelivered = false;
    private writeCallback?: (error?: Error | null) => void;
    private timer?: ReturnType<typeof setTimeout>;
    private deadline: number = Infinity;
    private credentials: CallCredentials;
    private readonly aborter = new AbortController();
    private fetchCount = 0;
    private responseBytes = 0;
    constructor(private readonly context: CallContext) {
        this.credentials = context.credentials._getCallCredentials();
    }
    getPeer(): string {
        return `https://${this.context.authority}`;
    }
    getAuthContext(): null {
        return null;
    }
    getCallNumber(): number {
        return 0;
    }
    /** Internal diagnostics contain counts only, no targets, metadata or messages. */
    diagnostics(): {
        terminal: boolean;
        fetchCount: number;
        requestBytes: number;
        responseBytes: number;
        timerActive: boolean;
    } {
        return { terminal: !!this.terminal, fetchCount: this.fetchCount, requestBytes: this.request?.length ?? 0, responseBytes: this.responseBytes, timerActive: this.timer !== undefined };
    }
    setCredentials(creds: CallCredentials): void {
        if (this.fetching || this.authReady || this.started) {
            this.cancelWithStatus(status.INTERNAL, 'WGA_LATE_CREDENTIALS');
            return;
        }
        this.credentials = this.credentials.compose(creds);
    }
    start(metadata: Metadata, listener: CallListener): void {
        if (this.started) {
            throw new Error('Call already started');
        }
        this.started = true;
        this.listener = listener;
        if (this.terminal) {
            this.deliverTerminal();
            return;
        }
        const c = this.context;
        if (c.closed) {
            this.finish(status.UNAVAILABLE, 'WGA_CHANNEL_CLOSED');
            return;
        }
        if (c.requestStream) {
            this.finish(status.UNIMPLEMENTED, 'WGA_REQUEST_STREAMING_UNSUPPORTED');
            return;
        }
        if (!/^\/[A-Za-z_][A-Za-z0-9_.]*\/[A-Za-z_][A-Za-z0-9_]*$/.test(c.path)) {
            this.finish(status.INTERNAL, 'WGA_INVALID_METHOD');
            return;
        }
        for (const key of Object.keys(c.options)) {
            if (!['deadline', 'credentials', 'host', 'parent', 'propagate_flags', 'interceptors', 'interceptor_providers'].includes(key)) {
                this.finish(status.UNIMPLEMENTED, 'WGA_CALL_OPTION');
                return;
            }
        }
        if (c.options.parent != null || (c.options.propagate_flags !== undefined && ![0, 65535].includes(c.options.propagate_flags)) || (c.options.interceptors?.length ?? 0) > 0 || (c.options.interceptor_providers?.length ?? 0) > 0) {
            this.finish(status.UNIMPLEMENTED, 'WGA_CALL_OPTION');
            return;
        }
        if (c.options.host !== undefined) {
            try {
                if (normalizeAuthority(c.options.host) !== c.authority) {
                    throw new Error();
                }
            }
            catch {
                this.finish(status.INTERNAL, 'WGA_AUTHORITY_OVERRIDE');
                return;
            }
        }
        const mo = metadata.getOptions();
        if (mo.waitForReady === true || mo.corked === true) {
            this.finish(status.UNIMPLEMENTED, 'WGA_METADATA_OPTION');
            return;
        }
        this.metadata = metadata.clone();
        if (c.options.credentials) {
            try {
                this.credentials = this.credentials.compose(c.options.credentials);
            }
            catch {
                this.finish(status.INTERNAL, 'WGA_CALL_CREDENTIALS');
                return;
            }
        }
        const d = c.options.deadline;
        this.deadline = d === undefined ? (c.config.defaultTimeoutMs === undefined ? Infinity : Date.now() + c.config.defaultTimeoutMs) : (d instanceof Date ? d.getTime() : d);
        if (typeof this.deadline !== 'number' || Number.isNaN(this.deadline) || this.deadline === -Infinity) {
            this.finish(status.INTERNAL, 'WGA_INVALID_DEADLINE');
            return;
        }
        if (this.deadline <= Date.now()) {
            this.finish(status.DEADLINE_EXCEEDED, 'WGA_DEADLINE');
            return;
        }
        this.armTimer();
        if (c.insecure && (!this.credentials.isEmpty() || ['authorization', 'cookie', 'x-api-key', 'x-goog-api-key'].some(k => this.metadata!.get(k).length > 0))) {
            this.finish(status.UNAUTHENTICATED, 'WGA_INSECURE_AUTH');
            return;
        }
        const service = c.path.slice(0, c.path.lastIndexOf('/'));
        const authOrigin = new URL('https://' + c.authority).origin;
        Promise.resolve().then(() => {
            if (this.terminal) {
                return null;
            }
            return this.credentials.generateMetadata({ service_url: authOrigin + service, method_name: c.path });
        }).then(auth => {
            if (this.terminal || auth === null) {
                return;
            }
            this.metadata!.merge(auth);
            this.authReady = true;
            this.maybeFetch();
        }).catch(error => {
            if (!this.terminal) {
                this.finish(authErrorCode(error), 'WGA_AUTH_METADATA');
            }
        });
    }
    sendMessageWithContext(context: {
        callback?: (error?: Error | null) => void;
        flags?: number;
    }, message: Buffer): void {
        // Upstream BufferHint=1 and NoCompress=2 preserve the single buffered,
        // identity-encoded request. WriteThrough=4 cannot promise a fetch flush.
        if (context.flags !== undefined && (!Number.isInteger(context.flags) || context.flags < 0 || context.flags > 3)) {
            context.callback?.(new Error('WGA_WRITE_FLAGS'));
            this.finish(status.UNIMPLEMENTED, 'WGA_WRITE_FLAGS');
            return;
        }
        if (this.terminal) {
            if (context.callback) {
                queueMicrotask(() => notify(() => context.callback!(new Error('WGA_CALL_TERMINATED'))));
            }
            return;
        }
        if (this.request !== undefined) {
            if (context.callback) {
                queueMicrotask(() => notify(() => context.callback!(new Error('WGA_MULTIPLE_REQUESTS'))));
            }
            this.finish(status.INTERNAL, 'WGA_MULTIPLE_REQUESTS');
            return;
        }
        this.writeCallback = context.callback;
        if (message.length > this.context.limits.maxSend) {
            this.finish(status.RESOURCE_EXHAUSTED, 'WGA_REQUEST_SIZE');
            return;
        }
        this.request = Buffer.from(message);
        this.ackWrite();
        this.maybeFetch();
    }
    halfClose(): void {
        if (this.terminal) {
            return;
        }
        this.halfClosed = true;
        this.maybeFetch();
    }
    startRead(): void {
        if (this.terminal) {
            return;
        }
        this.readDemand = true;
        const wake = this.wakeRead;
        this.wakeRead = undefined;
        wake?.();
    }
    cancelWithStatus(code: status, details: string): void {
        this.finish(code, details);
    }
    private armTimer(): void {
        if (this.deadline === Infinity || this.terminal) {
            return;
        }
        const left = this.deadline - Date.now();
        if (left <= 0) {
            this.finish(status.DEADLINE_EXCEEDED, 'WGA_DEADLINE');
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.armTimer();
        }, Math.min(left, 2147483647));
    }
    private ackWrite(error?: Error): void {
        const cb = this.writeCallback;
        this.writeCallback = undefined;
        if (cb) {
            queueMicrotask(() => notify(() => cb(error)));
        }
    }
    private maybeFetch(): void {
        if (this.terminal || this.fetching || !this.listener || !this.authReady || this.request === undefined || !this.halfClosed) {
            return;
        }
        this.fetching = true;
        void this.execute();
    }
    private async execute(): Promise<void> {
        const c = this.context;
        try {
            if (this.deadline <= Date.now()) {
                this.finish(status.DEADLINE_EXCEEDED, 'WGA_DEADLINE');
                return;
            }
            const headers = requestHeaders(this.metadata!, this.deadline === Infinity ? undefined : this.deadline - Date.now(), c.limits.userAgent, c.config.mode);
            const body = encodeFrame(this.request!);
            const init: RequestInit & { cf: { grpcWeb: 'convert' | 'passthrough' } } = {
                method: 'POST', headers, body, redirect: 'manual', signal: this.aborter.signal,
                // Override Worker-wide defaults so different clients can coexist.
                cf: { grpcWeb: c.config.mode === 'cloudflare' ? 'convert' : 'passthrough' },
            };
            this.fetchCount++;
            const response = await fetch(c.origin + c.path, init);
            this.request = undefined;
            if (this.terminal) {
                await response.body?.cancel().catch(() => {
                });
                return;
            }
            if (response.status >= 300 && response.status < 400) {
                await response.body?.cancel().catch(() => {
                });
                this.finish(status.UNKNOWN, 'WGA_REDIRECT_BLOCKED');
                return;
            }
            let initial: Metadata, headerStatus: StatusObject | null;
            try {
                initial = metadataFromHeaders(response.headers);
                headerStatus = statusFromHeaders(response.headers);
            }
            catch (e) {
                await response.body?.cancel().catch(() => {
                });
                throw e;
            }
            const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
            if (contentType !== 'application/grpc-web+proto' && contentType !== 'application/grpc-web') {
                await response.body?.cancel().catch(() => {
                });
                if (headerStatus) {
                    this.finishObject(headerStatus);
                }
                else {
                    this.finish(httpStatusToGrpc(response.status), 'WGA_NOT_GRPC_WEB');
                }
                return;
            }
            notify(() => this.listener!.onReceiveMetadata(initial));
            if (this.terminal) {
                await response.body?.cancel().catch(() => {
                });
                return;
            }
            let final: StatusObject | null = headerStatus;
            if (response.body) {
                for await (const frame of decodeFrames(response.body, c.limits.maxReceive, this.aborter.signal)) {
                    if (this.terminal) {
                        return;
                    }
                    if (headerStatus) {
                        throw new TransportError(status.INTERNAL, 'WGA_BODY_AFTER_HEADER_STATUS');
                    }
                    if (frame.trailer) {
                        final = parseTrailers(frame.payload);
                        continue;
                    }
                    this.responseBytes = frame.payload.length;
                    while (!this.readDemand && !this.terminal) {
                        await new Promise<void>(resolve => {
                            this.wakeRead = resolve;
                        });
                    }
                    if (this.terminal) {
                        return;
                    }
                    // A unary reader requests its single result once. Keep draining so
                    // the upstream client can reject duplicate responses and see status.
                    this.readDemand = !c.responseStream;
                    this.responseBytes = 0;
                    notify(() => this.listener!.onReceiveMessage(frame.payload));
                }
            }
            if (!this.terminal) {
                if (final) {
                    this.finishObject(final);
                }
                else {
                    this.finish(httpStatusToGrpc(response.status), 'WGA_MISSING_GRPC_STATUS');
                }
            }
        }
        catch (error) {
            if (!this.terminal) {
                if (error instanceof TransportError) {
                    this.finish(error.code, error.diagnostic);
                }
                else {
                    this.finish(status.UNAVAILABLE, 'WGA_FETCH_FAILED');
                }
            }
        }
    }
    private finish(code: status, details: string): void {
        this.finishObject({ code, details, metadata: new Metadata() });
    }
    private finishObject(result: StatusObject): void {
        if (this.terminal) {
            return;
        }
        this.terminal = result;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.request = undefined;
        this.metadata = undefined;
        this.responseBytes = 0;
        this.ackWrite(new Error('WGA_CALL_TERMINATED'));
        this.aborter.abort();
        const wake = this.wakeRead;
        this.wakeRead = undefined;
        wake?.();
        this.context.onFinish();
        this.deliverTerminal();
    }
    private deliverTerminal(): void {
        if (!this.listener || !this.terminal || this.terminalDelivered) {
            return;
        }
        this.terminalDelivered = true;
        const listener = this.listener, terminal = this.terminal;
        queueMicrotask(() => notify(() => listener.onReceiveStatus(terminal)));
    }
}
