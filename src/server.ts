import { Buffer } from 'node:buffer';
import { Metadata } from './metadata';
import type { ServerMethodDefinition } from './factory';
import type { CompressionEncoding } from './compression';
import type { ParentCall } from './call';
import { compressionAlgorithms, status, TransportError, WorkersGrpcConfigurationError } from './status';
import { decodeFrames, encodeFrame, encodeMessageFrame, headerBudget, metadataFromHeaders, METADATA_LIMIT, responseCompression } from './wire';

export interface GrpcWebServerContext extends ParentCall {
    readonly method: string;
    /** Application request metadata, excluding HTTP/gRPC transport control fields. */
    readonly metadata: Metadata;
    readonly signal: AbortSignal;
    /** Absolute milliseconds since the epoch, or Infinity. */
    readonly deadline: number;
    sendMetadata(metadata: Metadata): void;
    setTrailer(metadata: Metadata): void;
}
export interface GrpcWebServerOptions {
    maxReceiveMessageBytes?: number;
    maxSendMessageBytes?: number;
    maxWireMessageBytes?: number;
    compression?: compressionAlgorithms;
    defaultTimeoutMs?: number;
}
export type GrpcWebUnaryHandler<Request, Response> = (request: Request, context: GrpcWebServerContext) => Response | Promise<Response>;
export type GrpcWebServerStreamingHandler<Request, Response> = (request: Request, context: GrpcWebServerContext) => AsyncIterable<Response> | Promise<AsyncIterable<Response>>;
export type GrpcWebClientStreamingHandler<Request, Response> = GrpcWebUnaryHandler<AsyncIterable<Request>, Response>;
export type GrpcWebBidiStreamingHandler<Request, Response> = GrpcWebServerStreamingHandler<AsyncIterable<Request>, Response>;
/** Backward-compatible handler type for definitions whose stream flags have widened to boolean. */
export type GrpcWebHandler<Request, Response> = GrpcWebUnaryHandler<Request, Response> | GrpcWebServerStreamingHandler<Request, Response>;
type Definition = Record<string, ServerMethodDefinition<any, any>>;
type HandlerFor<Method, Request, Response> = Method extends { requestStream: true }
    ? Method extends { responseStream: true } ? GrpcWebBidiStreamingHandler<Request, Response>
        : Method extends { responseStream: false } ? GrpcWebClientStreamingHandler<Request, Response>
        : GrpcWebHandler<AsyncIterable<Request>, Response>
    : Method extends { responseStream: true } ? GrpcWebServerStreamingHandler<Request, Response>
        : Method extends { responseStream: false } ? GrpcWebUnaryHandler<Request, Response>
        : GrpcWebHandler<Request, Response>;
export type GrpcWebHandlers<D extends Definition> = {
    [K in keyof D]: D[K] extends ServerMethodDefinition<infer Request, infer Response> ? HandlerFor<D[K], Request, Response> : never;
};

/** Only this explicit error type exposes application-supplied details to peers. */
export class GrpcWebServerError extends Error {
    readonly metadata: Metadata;
    constructor(readonly code: status, readonly details: string, metadata = new Metadata()) {
        if (!Number.isInteger(code) || code < 1 || code > 16 || typeof details !== 'string' || !(metadata instanceof Metadata)) {
            throw new TypeError('Invalid gRPC-Web server error');
        }
        super(details);
        this.name = 'GrpcWebServerError';
        this.metadata = metadata.clone();
    }
}
const reserved = new Set(['content-type', 'content-length', 'content-encoding', 'connection', 'transfer-encoding', 'host', 'te',
    'grpc-status', 'grpc-message', 'grpc-encoding', 'grpc-accept-encoding', 'grpc-timeout']);
function metadataPairs(metadata: Metadata): [string, string][] {
    if (!(metadata instanceof Metadata)) throw new TransportError(status.INTERNAL, 'WGA_SERVER_METADATA');
    function* pairs(): Generator<[string, string]> {
        for (const [key, values] of metadata.entries()) {
            if (!/^[0-9a-z_.-]+$/.test(key) || reserved.has(key)) throw new TransportError(status.INTERNAL, 'WGA_SERVER_METADATA');
            for (const value of values) {
                const text = Buffer.isBuffer(value) ? value.toString('base64') : value;
                if (typeof text !== 'string' || /[^\x20-\x7e]/.test(text)) throw new TransportError(status.INTERNAL, 'WGA_SERVER_METADATA');
                yield [key, text];
            }
        }
    }
    return headerBudget(pairs(), 'WGA_SERVER_METADATA_SIZE');
}
function trailer(code: status, details: string, metadata = new Metadata()): Buffer {
    if (!Number.isInteger(code) || code < 0 || code > 16 || typeof details !== 'string') {
        throw new TransportError(status.INTERNAL, 'WGA_SERVER_STATUS');
    }
    if (Buffer.byteLength(details) > METADATA_LIMIT) throw new TransportError(status.RESOURCE_EXHAUSTED, 'WGA_SERVER_METADATA_SIZE');
    let message: string;
    try { message = encodeURIComponent(details); }
    catch { throw new TransportError(status.INTERNAL, 'WGA_SERVER_STATUS'); }
    const pairs = headerBudget([['grpc-status', String(code)], ['grpc-message', message], ...metadataPairs(metadata)], 'WGA_SERVER_METADATA_SIZE');
    const text = pairs.map(([key, value]) => `${key}: ${value}\r\n`).join('');
    return encodeFrame(Buffer.from(text), true);
}
function failure(error: unknown): { code: status; details: string; metadata: Metadata } {
    try {
        if (error instanceof GrpcWebServerError) return { code: error.code, details: error.details, metadata: error.metadata };
        if (error instanceof TransportError) return { code: error.code, details: error.diagnostic, metadata: new Metadata() };
    } catch {
        // Application failures may themselves throw during instanceof or field
        // inspection. Keep both the original and inspection errors private so
        // terminal cleanup still runs before sending the generic status.
    }
    return { code: status.INTERNAL, details: 'WGA_SERVER_HANDLER', metadata: new Metadata() };
}
function errorTrailer(error: unknown, trailing: Metadata): Buffer {
    const result = failure(error);
    try {
        const metadata = trailing.clone();
        metadata.merge(result.metadata);
        return trailer(result.code, result.details, metadata);
    } catch (trailerError) {
        // Discard application metadata if its final encoded form is too large.
        // The fallback itself must remain readable by the same client parser.
        const fallback = failure(trailerError);
        return trailer(fallback.code, fallback.details);
    }
}
function deadlineFor(header: string | null, fallback?: number): number {
    if (header === null) return fallback === undefined ? Infinity : Math.min(Number.MAX_SAFE_INTEGER, Date.now() + fallback);
    const match = /^(\d{1,8})([HMSmun])$/.exec(header);
    if (!match) throw new TransportError(status.INVALID_ARGUMENT, 'WGA_SERVER_TIMEOUT');
    const scales: Record<string, number> = { H: 3600000, M: 60000, S: 1000, m: 1, u: 0.001, n: 0.000001 };
    const scale = scales[match[2]];
    return Math.min(Number.MAX_SAFE_INTEGER, Date.now() + Math.ceil(Number(match[1]) * scale));
}

/** Binary gRPC-Web Fetch endpoint; does not implement grpc-js Server sockets. */
export function createGrpcWebHandler<const D extends Definition>(definition: D, handlers: GrpcWebHandlers<D>, options: GrpcWebServerOptions = {}): (request: Request) => Promise<Response> {
    const invalid = (): never => { throw new WorkersGrpcConfigurationError('WGA_SERVER_CONFIG', 'Invalid gRPC-Web server configuration'); };
    if (!definition || typeof definition !== 'object' || !handlers || typeof handlers !== 'object' || !options || typeof options !== 'object') invalid();
    for (const key of Object.keys(options)) if (!['maxReceiveMessageBytes', 'maxSendMessageBytes', 'maxWireMessageBytes', 'compression', 'defaultTimeoutMs'].includes(key)) invalid();
    function bound(value: number | undefined, fallback: number): number {
        const actual = value === undefined ? fallback : value;
        if (!Number.isSafeInteger(actual) || actual < 0 || actual > 0xffffffff) invalid();
        return actual;
    }
    const wireLimit = bound(options.maxWireMessageBytes, 32 * 1024 * 1024);
    const receiveLimit = Math.min(bound(options.maxReceiveMessageBytes, 4 * 1024 * 1024), wireLimit);
    const sendLimit = Math.min(bound(options.maxSendMessageBytes, 4 * 1024 * 1024), wireLimit);
    const compression = options.compression === undefined ? 0 : options.compression;
    if (![0, 1, 2].includes(compression)) invalid();
    if (options.defaultTimeoutMs !== undefined && (!Number.isSafeInteger(options.defaultTimeoutMs) || options.defaultTimeoutMs < 0)) invalid();
    const timeout = options.defaultTimeoutMs;
    const selected = (['identity', 'deflate', 'gzip'] as const)[compression];
    const routes = new Map<string, { definition: ServerMethodDefinition<any, any>; handler: GrpcWebHandler<any, any> }>();
    for (const key of Object.keys(definition)) {
        const item = definition[key];
        if (['__proto__', 'prototype', 'constructor'].includes(key) || !item || typeof item !== 'object'
            || !/^\/[A-Za-z_][A-Za-z0-9_.]*\/[A-Za-z_][A-Za-z0-9_]*$/.test(item.path)
            || typeof item.requestStream !== 'boolean' || typeof item.responseStream !== 'boolean'
            || typeof item.requestDeserialize !== 'function' || typeof item.responseSerialize !== 'function'
            || !Object.hasOwn(handlers, key) || typeof handlers[key] !== 'function' || routes.has(item.path)) invalid();
        routes.set(item.path, { definition: { ...item }, handler: handlers[key] });
    }
    if (!routes.size || Object.keys(handlers).some(key => !Object.hasOwn(definition, key))) invalid();
    return async request => {
        const early = (response: Response) => {
            // Start external cleanup without delaying the already selected response.
            void request.body?.cancel().catch(() => {});
            return response;
        };
        if (request.method !== 'POST') return early(new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } }));
        const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/grpc-web' && contentType !== 'application/grpc-web+proto') {
            return early(new Response('Unsupported media type', { status: 415 }));
        }
        const accepted = (request.headers.get('grpc-accept-encoding') ?? 'identity').split(',').map(value => value.trim());
        const encoding: CompressionEncoding = accepted.includes(selected) ? selected : 'identity';
        const baseHeaders = { 'content-type': contentType, 'grpc-accept-encoding': 'identity,deflate,gzip', 'grpc-encoding': encoding };
        const responseHeaders = (metadata: Metadata): Headers => {
            const headers = new Headers(baseHeaders);
            for (const [key, value] of metadataPairs(metadata)) headers.append(key, value);
            headerBudget(headers.entries(), 'WGA_SERVER_METADATA_SIZE');
            return headers;
        };
        const url = new URL(request.url);
        const route = !url.search && routes.get(url.pathname);
        if (!route) return early(new Response(trailer(status.UNIMPLEMENTED, 'WGA_SERVER_METHOD'), { headers: baseHeaders }));
        const aborter = new AbortController(), inputAborter = new AbortController();
        const pendingInterruptions = new Set<(error: TransportError) => void>();
        let timer: ReturnType<typeof setTimeout> | undefined, cleaned = false, headersSent = false, closed = false;
        let deadline = Infinity, interruptionError: TransportError | undefined;
        let iterator: AsyncIterator<unknown> | undefined, returnStarted = false, iterableOutput = false;
        let inputIterator: AsyncIterator<unknown> | undefined, inputClosed = false, inputReading = false;
        let inputFailure: unknown;
        let initial = new Metadata(), trailing = new Metadata();
        const disposeIterator = () => {
            if (returnStarted || !iterator) return;
            returnStarted = true;
            try { void Promise.resolve(iterator.return?.()).catch(() => {}); }
            catch { /* Cleanup exceptions never expose application data. */ }
        };
        const disposeInput = () => {
            if (inputClosed) return;
            inputClosed = true;
            inputAborter.abort();
            // Do not await arbitrary stream cancellation or generator cleanup.
            // Aborting decodeFrames releases a pending read before return().
            try { void Promise.resolve(inputIterator?.return?.()).catch(() => {}); }
            catch { /* Keep cleanup failures private. */ }
            if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
        };
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
            request.signal.removeEventListener('abort', callerAbort);
        };
        const stop = (code: status, details: string) => {
            if (!aborter.signal.aborted) {
                const error = new TransportError(code, details);
                interruptionError = error;
                aborter.abort();
                for (const interrupt of pendingInterruptions) interrupt(error);
                pendingInterruptions.clear();
            }
            cleanup();
            disposeIterator();
            disposeInput();
        };
        const callerAbort = () => stop(status.CANCELLED, 'WGA_SERVER_CANCELLED');
        const checkActive = () => {
            // Timers cannot interrupt synchronous application work or run ahead
            // of a ready promise chain. Enforce the absolute budget at boundaries,
            // keeping the first observed cancellation or input failure terminal.
            if (!interruptionError && !cleaned && deadline <= Date.now()) stop(status.DEADLINE_EXCEEDED, 'WGA_SERVER_DEADLINE');
            if (interruptionError) throw interruptionError;
        };
        const terminalError = (error: unknown): unknown => {
            try { checkActive(); }
            catch (interrupted) { return interrupted; }
            return error;
        };
        const race = <T>(operation: PromiseLike<T> | T): Promise<T> => new Promise((resolve, reject) => {
            // Only in-flight work owns a cancellation subscription. Racing every
            // message against one pending Promise would retain all settled
            // results until the call ends, even after downstream consumption.
            const interrupt = (error: TransportError) => reject(error);
            if (interruptionError) interrupt(interruptionError);
            else pendingInterruptions.add(interrupt);
            // Keep both handlers attached after cancellation so a late failure
            // from application work remains observed without delaying cleanup.
            void Promise.resolve(operation).then(value => {
                pendingInterruptions.delete(interrupt);
                resolve(value);
            }, error => {
                pendingInterruptions.delete(interrupt);
                reject(error);
            });
        });
        const errorResponse = (error: unknown): Response => {
            error = terminalError(error);
            const result = failure(error);
            stop(result.code, result.details);
            return new Response(errorTrailer(error, trailing), { headers: responseHeaders(initial) });
        };
        try {
            deadline = deadlineFor(request.headers.get('grpc-timeout'), timeout);
            const armTimer = () => {
                if (deadline === Infinity || cleaned) return;
                const remaining = deadline - Date.now();
                if (remaining <= 0) { stop(status.DEADLINE_EXCEEDED, 'WGA_SERVER_DEADLINE'); return; }
                timer = setTimeout(() => { timer = undefined; armTimer(); }, Math.min(remaining, 2147483647));
            };
            request.signal.addEventListener('abort', callerAbort, { once: true });
            if (request.signal.aborted) callerAbort();
            armTimer();
            const metadata = metadataFromHeaders(request.headers, 'request');
            const requestBody = request.body;
            if (!requestBody && !route.definition.requestStream) throw new TransportError(status.INVALID_ARGUMENT, 'WGA_SERVER_REQUEST_MESSAGE');
            const requestEncoding = responseCompression(request.headers);
            const decoded = (async function* () {
                // A missing Fetch body represents the same zero-message upload
                // as an empty stream for client- and bidi-streaming methods.
                if (!requestBody) return;
                for await (const value of decodeFrames(requestBody, receiveLimit, inputAborter.signal,
                    { encoding: requestEncoding, direction: 'request', maxWireBytes: wireLimit, onChunk: checkActive })) {
                    checkActive();
                    if (value.trailer) throw new TransportError(status.INVALID_ARGUMENT, 'WGA_SERVER_REQUEST_MESSAGE');
                    yield value.payload;
                }
            })();
            inputIterator = decoded;
            const requests: AsyncIterableIterator<unknown> = {
                [Symbol.asyncIterator]() { return this; },
                async next() {
                    if (inputFailure !== undefined) throw inputFailure;
                    checkActive();
                    if (inputClosed) return { done: true, value: undefined };
                    if (inputReading) {
                        inputFailure = new TransportError(status.INTERNAL, 'WGA_SERVER_REQUEST_CONCURRENT_READ');
                        stop(status.INTERNAL, 'WGA_SERVER_REQUEST_CONCURRENT_READ');
                        throw inputFailure;
                    }
                    inputReading = true;
                    try {
                        const value = await race(decoded.next());
                        checkActive();
                        if (inputClosed) return { done: true, value: undefined };
                        if (value.done) { inputClosed = true; return value; }
                        if (!route.definition.requestStream) return value;
                        let deserialized: unknown;
                        try { deserialized = route.definition.requestDeserialize(value.value); }
                        catch { throw new TransportError(status.INVALID_ARGUMENT, 'WGA_SERVER_DESERIALIZE'); }
                        checkActive();
                        return { done: false, value: deserialized };
                    } catch (error) {
                        error = terminalError(error);
                        // A handler may close its upload while next() is still
                        // reading. That input-only abort is normal completion;
                        // caller cancellation, deadlines and input faults remain terminal.
                        if (inputClosed && inputAborter.signal.aborted && !aborter.signal.aborted
                            && error instanceof TransportError && error.code === status.CANCELLED
                            && error.diagnostic === 'WGA_ABORTED') {
                            return { done: true, value: undefined };
                        }
                        const wasClosed = inputClosed;
                        inputFailure ??= error;
                        disposeInput();
                        if (!wasClosed) {
                            const result = failure(inputFailure);
                            stop(result.code, result.details);
                        }
                        throw inputFailure;
                    } finally { inputReading = false; }
                },
                async return() {
                    disposeInput();
                    return { done: true, value: undefined };
                },
            };
            let input: unknown = requests;
            if (!route.definition.requestStream) {
                const first = await requests.next();
                if (first.done || !(await requests.next()).done) throw new TransportError(status.INVALID_ARGUMENT, 'WGA_SERVER_REQUEST_MESSAGE');
                checkActive();
                try { input = route.definition.requestDeserialize(first.value as Buffer); }
                catch { throw new TransportError(status.INVALID_ARGUMENT, 'WGA_SERVER_DESERIALIZE'); }
            }
            const context: GrpcWebServerContext = { method: route.definition.path, metadata, signal: aborter.signal, deadline,
                get cancelled() { return aborter.signal.aborted; },
                getDeadline() { return deadline; },
                on(event, listener) {
                    if (event !== 'cancelled') throw new TypeError('Unsupported parent event');
                    aborter.signal.addEventListener('abort', listener);
                    return this;
                },
                removeListener(event, listener) {
                    if (event !== 'cancelled') throw new TypeError('Unsupported parent event');
                    aborter.signal.removeEventListener('abort', listener);
                    return this;
                },
                sendMetadata(value) {
                    if (headersSent || aborter.signal.aborted) throw new TransportError(status.INTERNAL, 'WGA_SERVER_METADATA_SENT');
                    metadataPairs(value);
                    const merged = initial.clone();
                    merged.merge(value.clone());
                    responseHeaders(merged);
                    initial = merged;
                },
                setTrailer(value) {
                    if (closed || aborter.signal.aborted) throw new TransportError(status.INTERNAL, 'WGA_SERVER_TRAILER_SENT');
                    trailer(status.OK, '', value);
                    trailing = value.clone();
                },
            };
            const producing = Promise.resolve().then(() => {
                checkActive();
                return route.handler(input, context);
            }).then(output => {
                // Own the iterator as part of handler completion, before any
                // awaiting continuation can observe cancellation. The same
                // owner also disposes a handler that resolves after race ended.
                const factory = output && output[Symbol.asyncIterator];
                if (typeof factory === 'function') {
                    iterableOutput = true;
                    iterator = Reflect.apply(factory, output, []);
                    if (aborter.signal.aborted) disposeIterator();
                }
                return output;
            });
            const output = await race(producing);
            if (interruptionError) throw interruptionError;
            if (inputFailure !== undefined) throw inputFailure;
            let first: IteratorResult<unknown>;
            if (route.definition.responseStream) {
                if (!iterableOutput) throw new TransportError(status.INTERNAL, 'WGA_SERVER_HANDLER_KIND');
                checkActive();
                first = await race(iterator!.next());
                if (!first || (typeof first !== 'object' && typeof first !== 'function')) throw new TransportError(status.INTERNAL, 'WGA_SERVER_HANDLER_KIND');
            } else {
                checkActive();
                if (iterableOutput) throw new TransportError(status.INTERNAL, 'WGA_SERVER_HANDLER_KIND');
                first = { done: false, value: output };
                iterator = { next: async () => ({ done: true, value: undefined }) };
            }
            checkActive();
            if (inputFailure !== undefined) throw inputFailure;
            const headers = responseHeaders(initial);
            checkActive();
            headersSent = true;
            let buffered: IteratorResult<unknown> | undefined = first;
            const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    if (closed) return;
                    try {
                        // Caller abort may already have disposed the iterator
                        // while the consumer was not requesting response data.
                        checkActive();
                        const item = buffered ?? await race(iterator!.next());
                        buffered = undefined;
                        checkActive();
                        if (!item || (typeof item !== 'object' && typeof item !== 'function')) throw new TransportError(status.INTERNAL, 'WGA_SERVER_HANDLER_KIND');
                        if (item.done) {
                            if (inputFailure !== undefined) throw inputFailure;
                            disposeInput();
                            const terminal = trailer(status.OK, '', trailing);
                            checkActive();
                            controller.enqueue(terminal);
                            closed = true;
                            cleanup();
                            controller.close();
                            return;
                        }
                        let bytes: Buffer;
                        try { bytes = route.definition.responseSerialize(item.value); }
                        catch { throw new TransportError(status.INTERNAL, 'WGA_SERVER_SERIALIZE'); }
                        checkActive();
                        if (!(bytes instanceof Uint8Array)) throw new TransportError(status.INTERNAL, 'WGA_SERVER_SERIALIZE');
                        if (bytes.byteLength > sendLimit) throw new TransportError(status.RESOURCE_EXHAUSTED, 'WGA_SERVER_RESPONSE_SIZE');
                        const encoded = await race(encodeMessageFrame(bytes, encoding, wireLimit, aborter.signal));
                        if (closed) return;
                        checkActive();
                        controller.enqueue(encoded);
                    } catch (error) {
                        if (closed) return;
                        error = terminalError(error);
                        const result = failure(error);
                        stop(result.code, result.details);
                        controller.enqueue(errorTrailer(error, trailing));
                        closed = true;
                        controller.close();
                    }
                },
                cancel() {
                    closed = true;
                    buffered = undefined;
                    initial = new Metadata();
                    trailing = new Metadata();
                    stop(status.CANCELLED, 'WGA_SERVER_CANCELLED');
                },
            }, { highWaterMark: 0 });
            return new Response(body, { headers });
        } catch (error) { return errorResponse(error); }
    };
}
