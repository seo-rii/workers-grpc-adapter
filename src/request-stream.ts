import { Buffer } from 'node:buffer';
import { CompressionEncoding } from './compression';
import { encodeMessageFrame } from './wire';
import { status, TransportError } from './status';

export interface RequestStreamBodyOptions {
    maxMessageBytes: number;
    maxWireBytes: number;
    compression: CompressionEncoding;
    /** Fetch cancelled the request body; emitted at most once. */
    onCancel?: (error: Error) => void;
}
interface PendingWrite {
    bytes: number;
    frame?: Buffer;
    resolve: () => void;
    reject: (error: Error) => void;
}
/** Internal bounded producer for experimental gateway request streaming. */
export class RequestStreamBody {
    readonly body: ReadableStream<Uint8Array>;
    private controller!: ReadableStreamDefaultController<Uint8Array>;
    private pending?: PendingWrite;
    private demand = false;
    private ending = false;
    private closed = false;
    private failure?: Error;
    private readonly aborter = new AbortController();
    private readonly maxMessageBytes: number;
    private readonly maxWireBytes: number;
    private readonly compression: CompressionEncoding;
    private readonly onCancel?: (error: Error) => void;
    constructor(options: RequestStreamBodyOptions) {
        for (const [size, minimum] of [[options.maxMessageBytes, 0], [options.maxWireBytes, 1]]) {
            if (!Number.isSafeInteger(size) || size < minimum || size > 2147483647) {
                throw new TransportError(status.INTERNAL, 'WGA_REQUEST_STREAM_INVALID_LIMIT');
            }
        }
        if (!['identity', 'gzip', 'deflate'].includes(options.compression)) {
            throw new TransportError(status.UNIMPLEMENTED, 'WGA_COMPRESSION_ENCODING');
        }
        this.maxMessageBytes = options.maxMessageBytes;
        this.maxWireBytes = options.maxWireBytes;
        this.compression = options.compression;
        this.onCancel = options.onCancel;
        this.body = new ReadableStream<Uint8Array>({
            start: controller => { this.controller = controller; },
            pull: () => { this.demand = true; this.flush(); },
            cancel: () => {
                if (this.closed) return;
                const error = new TransportError(status.CANCELLED, 'WGA_REQUEST_STREAM_CANCELLED');
                this.terminate(error, false);
                this.onCancel?.(error);
            },
        }, { highWaterMark: 0 });
    }
    /** Includes the input during encoding or the one encoded frame awaiting pull. */
    bufferedBytes(): number { return this.pending?.bytes ?? 0; }
    /** Resolves on downstream pull acceptance, never promises an actual network flush. */
    write(message: Uint8Array, noCompress = false): Promise<void> {
        if (this.closed || this.ending) return Promise.reject(this.failure
            ?? new TransportError(status.INTERNAL, 'WGA_REQUEST_STREAM_CLOSED'));
        if (this.pending) return Promise.reject(new TransportError(status.RESOURCE_EXHAUSTED, 'WGA_REQUEST_STREAM_BACKPRESSURE'));
        if (!(message instanceof Uint8Array)) return Promise.reject(new TransportError(status.INTERNAL, 'WGA_REQUEST_STREAM_INVALID_MESSAGE'));
        if (message.byteLength > this.maxMessageBytes) {
            const error = new TransportError(status.RESOURCE_EXHAUSTED, 'WGA_REQUEST_SIZE');
            this.abort(error); return Promise.reject(error);
        }
        // Snapshot before asynchronous compression or a delayed Fetch pull.
        const copy = Buffer.from(message);
        return new Promise<void>((resolve, reject) => {
            const pending: PendingWrite = { bytes: copy.length, resolve, reject };
            this.pending = pending;
            void encodeMessageFrame(copy, this.compression, this.maxWireBytes, this.aborter.signal, noCompress).then(frame => {
                if (this.pending !== pending || this.closed) return;
                pending.frame = frame;
                pending.bytes = frame.length;
                this.flush();
            }).catch(error => {
                if (this.pending === pending && !this.closed) this.abort(error instanceof Error ? error
                    : new TransportError(status.INTERNAL, 'WGA_REQUEST_STREAM_ENCODING'));
            });
        });
    }
    /** Graceful half-close: an outstanding frame is handed off before EOF. */
    end(): void {
        if (this.closed || this.ending) return;
        this.ending = true;
        if (!this.pending) { this.closed = true; this.controller.close(); }
    }
    /** A terminal response forbids more writes; clean EOF releases Fetch's upload pump. */
    closeFromResponse(): void {
        if (this.closed) return;
        this.terminate(new TransportError(status.CANCELLED, 'WGA_REQUEST_STREAM_RESPONSE_COMPLETE'), false);
        this.controller.close();
    }
    /** Terminal call completion/error: discard pending data and reject its writer. */
    abort(error: Error = new TransportError(status.CANCELLED, 'WGA_REQUEST_STREAM_ABORTED')): void {
        if (this.closed) return;
        this.terminate(error, true);
    }
    private terminate(error: Error, errorBody: boolean): void {
        this.closed = true;
        this.failure = error;
        this.demand = false;
        this.aborter.abort();
        const pending = this.pending;
        this.pending = undefined;
        if (errorBody) this.controller.error(error);
        pending?.reject(error);
    }
    private flush(): void {
        const pending = this.pending;
        if (this.closed || !this.demand || !pending?.frame) return;
        this.pending = undefined;
        this.demand = false;
        try {
            this.controller.enqueue(pending.frame);
            pending.resolve();
            if (this.ending) { this.closed = true; this.controller.close(); }
        } catch (error) {
            const failure = error instanceof Error ? error : new TransportError(status.INTERNAL, 'WGA_REQUEST_STREAM_PULL');
            pending.reject(failure);
            this.abort(failure);
        }
    }
}
