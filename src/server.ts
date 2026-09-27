import { Buffer } from 'node:buffer';
import { Metadata } from './metadata';
import type { ServerMethodDefinition } from './factory';
import type { CompressionEncoding } from './compression';
import { compressionAlgorithms, status, TransportError, WorkersGrpcConfigurationError } from './status';
import { decodeFrames, encodeFrame, encodeMessageFrame, metadataFromHeaders, METADATA_LIMIT, responseCompression } from './wire';

export interface GrpcWebServerContext {
    readonly method: string;
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
export type GrpcWebHandler<Request, Response> = (request: Request, context: GrpcWebServerContext) =>
    Response | Promise<Response> | AsyncIterable<Response> | Promise<AsyncIterable<Response>>;
type Definition = Record<string, ServerMethodDefinition<any, any>>;
export type GrpcWebHandlers<D extends Definition> = {
    [K in keyof D]: D[K] extends ServerMethodDefinition<infer Request, infer Response> ? GrpcWebHandler<Request, Response> : never;
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
    const result: [string, string][] = [];
    let size = 0;
    for (const [key, values] of metadata.entries()) {
        if (!/^[0-9a-z_.-]+$/.test(key) || reserved.has(key)) throw new TransportError(status.INTERNAL, 'WGA_SERVER_METADATA');
        for (const value of values) {
            const text = Buffer.isBuffer(value) ? value.toString('base64') : value;
            if (typeof text !== 'string' || /[^\x20-\x7e]/.test(text)) throw new TransportError(status.INTERNAL, 'WGA_SERVER_METADATA');
            size += Buffer.byteLength(key) + Buffer.byteLength(text) + 32;
            if (size > METADATA_LIMIT) throw new TransportError(status.RESOURCE_EXHAUSTED, 'WGA_SERVER_METADATA_SIZE');
            result.push([key, text]);
        }
    }
    return result;
}
function trailer(code: status, details: string, metadata = new Metadata()): Buffer {
    if (!Number.isInteger(code) || code < 0 || code > 16 || typeof details !== 'string') {
        throw new TransportError(status.INTERNAL, 'WGA_SERVER_STATUS');
    }
    if (Buffer.byteLength(details) > METADATA_LIMIT) throw new TransportError(status.RESOURCE_EXHAUSTED, 'WGA_SERVER_METADATA_SIZE');
    let message: string;
    try { message = encodeURIComponent(details); }
    catch { throw new TransportError(status.INTERNAL, 'WGA_SERVER_STATUS'); }
    const text = [`grpc-status: ${code}\r\n`, `grpc-message: ${message}\r\n`,
        ...metadataPairs(metadata).map(([key, value]) => `${key}: ${value}\r\n`)].join('');
    if (Buffer.byteLength(text) > METADATA_LIMIT) throw new TransportError(status.RESOURCE_EXHAUSTED, 'WGA_SERVER_METADATA_SIZE');
    return encodeFrame(Buffer.from(text), true);
}
function failure(error: unknown): { code: status; details: string; metadata: Metadata } {
    if (error instanceof GrpcWebServerError) return { code: error.code, details: error.details, metadata: error.metadata };
    if (error instanceof TransportError) return { code: error.code, details: error.diagnostic, metadata: new Metadata() };
    return { code: status.INTERNAL, details: 'WGA_SERVER_HANDLER', metadata: new Metadata() };
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
export function createGrpcWebHandler<D extends Definition>(definition: D, handlers: GrpcWebHandlers<D>, options: GrpcWebServerOptions = {}): (request: Request) => Promise<Response> {
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
        if (item.requestStream) throw new WorkersGrpcConfigurationError('WGA_REQUEST_STREAMING_UNSUPPORTED', 'gRPC-Web Fetch handlers accept one request message');
        routes.set(item.path, { definition: { ...item }, handler: handlers[key] });
    }
    if (!routes.size || Object.keys(handlers).some(key => !Object.hasOwn(definition, key))) invalid();
    return async request => {
        const early = async (response: Response) => {
            await request.body?.cancel().catch(() => {});
            return response;
        };
        if (request.method !== 'POST') return early(new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } }));
        const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/grpc-web' && contentType !== 'application/grpc-web+proto') {
            return early(new Response('Unsupported media type', { status: 415 }));
        }
        const baseHeaders = { 'content-type': contentType, 'grpc-accept-encoding': 'identity,deflate,gzip' };
        const url = new URL(request.url);
        const route = !url.search && routes.get(url.pathname);
        if (!route) return early(new Response(trailer(status.UNIMPLEMENTED, 'WGA_SERVER_METHOD'), { headers: baseHeaders }));
        const aborter = new AbortController();
        let rejectAbort: (error: TransportError) => void = () => {};
        const interruption = new Promise<never>((_, reject) => { rejectAbort = reject; });
        void interruption.catch(() => {});
        let timer: ReturnType<typeof setTimeout> | undefined, cleaned = false, headersSent = false, closed = false;
        let iterator: AsyncIterator<unknown> | undefined, returnStarted = false;
        let initial = new Metadata(), trailing = new Metadata();
        const disposeIterator = () => {
            if (returnStarted || !iterator) return;
            returnStarted = true;
            try { void Promise.resolve(iterator.return?.()).catch(() => {}); }
            catch { /* Cleanup exceptions never expose application data. */ }
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
                aborter.abort();
                rejectAbort(error);
            }
            cleanup();
            disposeIterator();
            if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
        };
        const callerAbort = () => stop(status.CANCELLED, 'WGA_SERVER_CANCELLED');
        const race = <T>(operation: PromiseLike<T> | T): Promise<T> => Promise.race([Promise.resolve(operation), interruption]);
        const errorResponse = (error: unknown): Response => {
            const result = failure(error);
            stop(result.code, result.details);
            let bytes: Buffer;
            try { const metadata = trailing.clone(); metadata.merge(result.metadata); bytes = trailer(result.code, result.details, metadata); }
            catch { bytes = trailer(status.INTERNAL, 'WGA_SERVER_STATUS'); }
            const headers = new Headers(baseHeaders);
            for (const [key, value] of metadataPairs(initial)) headers.append(key, value);
            return new Response(bytes, { headers });
        };
        try {
            const deadline = deadlineFor(request.headers.get('grpc-timeout'), timeout);
            const armTimer = () => {
                if (deadline === Infinity || cleaned) return;
                const remaining = deadline - Date.now();
                if (remaining <= 0) { stop(status.DEADLINE_EXCEEDED, 'WGA_SERVER_DEADLINE'); return; }
                timer = setTimeout(() => { timer = undefined; armTimer(); }, Math.min(remaining, 2147483647));
            };
            request.signal.addEventListener('abort', callerAbort, { once: true });
            if (request.signal.aborted) callerAbort();
            armTimer();
            const metadata = metadataFromHeaders(request.headers);
            if (!request.body) throw new TransportError(status.INVALID_ARGUMENT, 'WGA_SERVER_REQUEST_MESSAGE');
            let message: Buffer | undefined;
            await race((async () => {
                for await (const value of decodeFrames(request.body!, receiveLimit, aborter.signal,
                    { encoding: responseCompression(request.headers), maxWireBytes: wireLimit })) {
                    if (value.trailer || message !== undefined) throw new TransportError(status.INVALID_ARGUMENT, 'WGA_SERVER_REQUEST_MESSAGE');
                    message = value.payload;
                }
            })());
            if (message === undefined) throw new TransportError(status.INVALID_ARGUMENT, 'WGA_SERVER_REQUEST_MESSAGE');
            let input: unknown;
            try { input = route.definition.requestDeserialize(message); }
            catch { throw new TransportError(status.INVALID_ARGUMENT, 'WGA_SERVER_DESERIALIZE'); }
            const context: GrpcWebServerContext = { method: route.definition.path, metadata, signal: aborter.signal, deadline,
                sendMetadata(value) {
                    if (headersSent || aborter.signal.aborted) throw new TransportError(status.INTERNAL, 'WGA_SERVER_METADATA_SENT');
                    metadataPairs(value);
                    const merged = initial.clone();
                    merged.merge(value.clone());
                    metadataPairs(merged);
                    initial = merged;
                },
                setTrailer(value) {
                    if (closed || aborter.signal.aborted) throw new TransportError(status.INTERNAL, 'WGA_SERVER_TRAILER_SENT');
                    metadataPairs(value);
                    trailing = value.clone();
                },
            };
            const producing = Promise.resolve().then(() => {
                if (aborter.signal.aborted) throw new TransportError(status.CANCELLED, 'WGA_SERVER_CANCELLED');
                return route.handler(input, context);
            });
            // A handler may finish after its deadline and return an iterator that
            // already owns resources. Dispose it even though race has settled.
            void producing.then(output => {
                if (aborter.signal.aborted && !iterator && output && typeof output[Symbol.asyncIterator] === 'function') {
                    iterator = output[Symbol.asyncIterator]();
                    disposeIterator();
                }
            }).catch(() => {});
            const output = await race(producing);
            if (aborter.signal.aborted) await interruption;
            let first: IteratorResult<unknown>;
            if (route.definition.responseStream) {
                if (!output || typeof output[Symbol.asyncIterator] !== 'function') throw new TransportError(status.INTERNAL, 'WGA_SERVER_HANDLER_KIND');
                iterator = output[Symbol.asyncIterator]();
                first = await race(iterator!.next());
            } else {
                if (output && typeof output[Symbol.asyncIterator] === 'function') throw new TransportError(status.INTERNAL, 'WGA_SERVER_HANDLER_KIND');
                first = { done: false, value: output };
                iterator = { next: async () => ({ done: true, value: undefined }) };
            }
            const headers = new Headers(baseHeaders);
            for (const [key, value] of metadataPairs(initial)) headers.append(key, value);
            const accepted = (request.headers.get('grpc-accept-encoding') ?? 'identity').split(',').map(value => value.trim());
            const encoding: CompressionEncoding = accepted.includes(selected) ? selected : 'identity';
            headers.set('grpc-encoding', encoding);
            headersSent = true;
            let buffered: IteratorResult<unknown> | undefined = first;
            const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    if (closed) return;
                    try {
                        const item = buffered ?? await race(iterator!.next());
                        buffered = undefined;
                        if (aborter.signal.aborted) await interruption;
                        if (!item || typeof item !== 'object') throw new TransportError(status.INTERNAL, 'WGA_SERVER_HANDLER_KIND');
                        if (item.done) {
                            controller.enqueue(trailer(status.OK, '', trailing));
                            closed = true;
                            cleanup();
                            controller.close();
                            return;
                        }
                        let bytes: Buffer;
                        try { bytes = route.definition.responseSerialize(item.value); }
                        catch { throw new TransportError(status.INTERNAL, 'WGA_SERVER_SERIALIZE'); }
                        if (!(bytes instanceof Uint8Array)) throw new TransportError(status.INTERNAL, 'WGA_SERVER_SERIALIZE');
                        if (bytes.byteLength > sendLimit) throw new TransportError(status.RESOURCE_EXHAUSTED, 'WGA_SERVER_RESPONSE_SIZE');
                        const encoded = await race(encodeMessageFrame(bytes, encoding, wireLimit, aborter.signal));
                        if (closed) return;
                        if (aborter.signal.aborted) await interruption;
                        controller.enqueue(encoded);
                    } catch (error) {
                        if (closed) return;
                        const result = failure(error);
                        stop(result.code, result.details);
                        let bytes: Buffer;
                        try { const metadata = trailing.clone(); metadata.merge(result.metadata); bytes = trailer(result.code, result.details, metadata); }
                        catch { bytes = trailer(status.INTERNAL, 'WGA_SERVER_STATUS'); }
                        controller.enqueue(bytes);
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
