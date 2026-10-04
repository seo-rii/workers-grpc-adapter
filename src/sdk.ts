import { Readable } from 'node:stream';
import { nextTick } from 'node:process';
import { Metadata } from './metadata';
import { propagate, status } from './status';
import type { ParentCall } from './call';
import type { ServiceError } from './call-surface';

/** Structural subset; no Google SDK dependency is loaded by this entry. */
export interface SdkGaxOptions {
    otherArgs?: { [name: string]: unknown; options?: object };
}
export interface SdkCancellationOptions<Options extends object = object> {
    /** Forward the options passed to start to every SDK operation in that scope. */
    gaxOptions?: Options;
    signal?: AbortSignal;
}
export interface SdkQueryStreamOptions<Options extends object = object> extends SdkCancellationOptions<Options> {
    /** Wrapper queue in objects, 1..1024 (default 1); excludes SDK-owned buffers. */
    highWaterMark?: number;
}
export interface CancellableCall<T> {
    readonly promise: Promise<T>;
    /** Cancels local waiting and associated adapter RPCs; never rolls back a write. */
    cancel(): void;
}
/** Datastore returns a Transform whose end() also stops subsequent pages. */
export type SdkQuerySource = Readable & { end(): unknown };
export interface SdkQueryStream<T> extends Readable {
    read(size?: number): T | null;
    [Symbol.asyncIterator](): NodeJS.AsyncIterator<T>;
    iterator(options?: { destroyOnReturn?: boolean }): NodeJS.AsyncIterator<T>;
}

// A class instance is deliberate: Datastore's extend(true, ..., gaxOptions)
// clones plain objects. Cloning a plain cancellation controller would freeze
// its cancelled flag at the value observed during lazy SDK initialization.
class CancellationParent implements ParentCall {
    #cancelled = false;
    #listeners = new Set<() => void>();
    get cancelled(): boolean { return this.#cancelled; }
    getDeadline(): number { return Infinity; }
    on(_event: 'cancelled', listener: () => void): this { this.#listeners.add(listener); return this; }
    removeListener(_event: 'cancelled', listener: () => void): this { this.#listeners.delete(listener); return this; }
    cancel(): void {
        if (this.#cancelled) return;
        this.#cancelled = true;
        const listeners = [...this.#listeners];
        this.#listeners.clear();
        for (const listener of listeners) {
            try { listener(); } catch { /* One child cannot prevent sibling cleanup. */ }
        }
    }
    release(): void { this.#listeners.clear(); }
}
function cancelledError(): ServiceError {
    const details = 'Cancelled by SDK helper';
    return Object.assign(new Error(`1 CANCELLED: ${details}`), { code: status.CANCELLED, details, metadata: new Metadata() });
}
function record(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('WGA_SDK_OPTIONS');
    return value as Record<string, unknown>;
}
function prepare<Options extends object>(options: SdkCancellationOptions<Options>, parent: CancellationParent): Options & SdkGaxOptions {
    record(options);
    const gax = options.gaxOptions === undefined ? {} : record(options.gaxOptions);
    const other = gax.otherArgs === undefined ? {} : record(gax.otherArgs);
    const call = other.options === undefined ? {} : record(other.options);
    if ('parent' in call || 'propagate_flags' in call) throw new TypeError('WGA_SDK_PARENT_CONFLICT');
    if (options.signal !== undefined && (options.signal === null || typeof options.signal.aborted !== 'boolean'
        || typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function')) {
        throw new TypeError('WGA_SDK_SIGNAL');
    }
    return { ...gax, otherArgs: { ...other, options: { ...call, parent, propagate_flags: propagate.CANCELLATION } } } as Options & SdkGaxOptions;
}
function subscribe(signal: AbortSignal | undefined, cancel: () => void): () => void {
    if (!signal) return () => {};
    if (signal.aborted) { cancel(); return () => {}; }
    signal.addEventListener('abort', cancel, { once: true });
    // Covers an abort during custom signal subscription as well as the normal
    // native AbortSignal path. Cleanup is safe after synchronous cancellation.
    if (signal.aborted) cancel();
    return () => signal.removeEventListener('abort', cancel);
}

/** Opt-in cancellation for an SDK promise whose RPC options reach this adapter. */
export function cancellableCall<T, Options extends object = object>(
    start: (gaxOptions: Options & SdkGaxOptions) => PromiseLike<T>,
    options: SdkCancellationOptions<Options> = {},
): CancellableCall<T> {
    if (typeof start !== 'function') throw new TypeError('WGA_SDK_START');
    const parent = new CancellationParent(), gaxOptions = prepare(options, parent);
    let active = true, cancelled = false, detach = () => {};
    let pending: PromiseLike<T> | undefined, cancelledPending = false;
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const release = () => { detach(); parent.release(); };
    const cancelPending = () => {
        if (!pending || cancelledPending) return;
        cancelledPending = true;
        try {
            const cancellable = pending as PromiseLike<T> & { cancel?: () => void };
            if (typeof cancellable.cancel === 'function') cancellable.cancel();
        } catch { /* Local cancellation is final even if an SDK cancel hook fails. */ }
    };
    const cancel = () => {
        if (!active) return;
        active = false; cancelled = true;
        parent.cancel(); release(); reject(cancelledError()); cancelPending();
    };
    detach = subscribe(options.signal, cancel);
    if (!active) { release(); return Object.freeze({ promise, cancel }); }
    try {
        pending = start(gaxOptions);
        if (pending === null || pending === undefined || typeof pending.then !== 'function') throw new TypeError('WGA_SDK_PROMISE_REQUIRED');
        Promise.resolve(pending).then(value => {
            if (!active) return;
            active = false; release(); resolve(value);
        }, error => {
            if (!active) return;
            active = false; parent.cancel(); release(); reject(error);
        });
        if (cancelled) cancelPending();
    } catch (error) {
        if (active) { active = false; parent.cancel(); release(); reject(error); }
    }
    return Object.freeze({ promise, cancel });
}

/** Wrap a Datastore query stream with scoped destroy/iterator-break cancellation. */
export function cancellableQueryStream<T = unknown, Options extends object = object>(
    start: (gaxOptions: Options & SdkGaxOptions) => SdkQuerySource,
    options: SdkQueryStreamOptions<Options> = {},
): SdkQueryStream<T> {
    if (typeof start !== 'function') throw new TypeError('WGA_SDK_START');
    const parent = new CancellationParent(), gaxOptions = prepare(options, parent);
    const highWaterMark = options.highWaterMark ?? 1;
    if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1 || highWaterMark > 1024) throw new TypeError('WGA_SDK_QUEUE_LIMIT');
    let source: Readable | undefined, complete = false, stopped = false, reading = false, detach = () => {}, restoreDestroy = () => {};
    const release = () => { detach(); parent.release(); };
    const removeDataListeners = () => {
        source?.removeListener('data', onData);
        source?.removeListener('end', onEnd);
        source?.removeListener('info', onInfo);
        source?.removeListener('metadata', onMetadata);
        source?.removeListener('status', onStatus);
    };
    const removeListeners = () => {
        removeDataListeners(); source?.removeListener('error', onError); source?.removeListener('close', onClose);
        restoreDestroy();
    };
    const stopSource = () => {
        if (!source || stopped) return;
        stopped = true; removeDataListeners();
        // The pinned SDK tests its readable EOF flag before requesting another
        // page. destroy() alone does not set that flag; end() must run here.
        try {
            const end = (source as Partial<SdkQuerySource>).end;
            if (typeof end === 'function') end.call(source);
        } catch { /* Still destroy the owned source after end() fails. */ }
        try { source.destroy(); } catch { removeListeners(); }
        // closed can become true before Node emits its queued error/close.
        // Keep the error listener through that emission, including a source
        // which the SDK destroyed synchronously before returning it.
        if (source.closed) nextTick(removeListeners);
    };
    const stream = new Readable({ objectMode: true, highWaterMark,
        read() { reading = true; source?.resume(); },
        destroy(error, callback) {
            if (!complete) { parent.cancel(); stopSource(); }
            release(); callback(error);
        },
    }) as SdkQueryStream<T>;
    const onData = (value: T) => { if (!stream.destroyed && !stream.push(value)) source?.pause(); };
    const onEnd = () => {
        if (stream.destroyed) return;
        complete = true; release(); stream.push(null); stopSource();
    };
    // EOF commits success. The owned source may still report a later cleanup
    // error from _destroy; keep handling it without producing a second outcome.
    const onError = (error: Error) => { if (!complete && !stream.destroyed) stream.destroy(error); };
    const onClose = () => {
        removeListeners();
        if (!complete && !stream.destroyed) stream.destroy(new Error('WGA_SDK_STREAM_CLOSED'));
    };
    const onInfo = (...args: unknown[]) => { if (!stream.destroyed) stream.emit('info', ...args); };
    const onMetadata = (...args: unknown[]) => { if (!stream.destroyed) stream.emit('metadata', ...args); };
    const onStatus = (...args: unknown[]) => { if (!stream.destroyed) stream.emit('status', ...args); };
    detach = subscribe(options.signal, () => stream.destroy(cancelledError()));
    if (stream.destroyed) { release(); return stream; }
    try {
        const candidate = start(gaxOptions);
        if (!(candidate instanceof Readable)) throw new TypeError('WGA_SDK_QUERY_SOURCE');
        source = candidate;
        source.on('error', onError); source.on('close', onClose);
        if (!source.destroyed) {
            // The helper owns this one source. Observe its standard _destroy
            // callback as well as events: emitClose:false sources otherwise
            // provide no event when an asynchronous successful destroy ends.
            // Restore the exact original method after cleanup; no SDK class or
            // shared client is modified, and no polling/timer is required.
            const original = source._destroy, owned = Object.hasOwn(source, '_destroy');
            const observedDestroy: Readable['_destroy'] = function(this: Readable, error, callback) {
                let called = false;
                const done: Parameters<Readable['_destroy']>[1] = cleanupError => {
                    if (called) return;
                    called = true;
                    try { callback(cleanupError); }
                    finally { restoreDestroy(); nextTick(removeListeners); }
                };
                try { original.call(this, error, done); }
                catch (failure) { done(failure instanceof Error ? failure : new Error('WGA_SDK_STREAM_CLEANUP')); }
            };
            source._destroy = observedDestroy;
            restoreDestroy = () => {
                if (candidate._destroy !== observedDestroy) return;
                if (owned) candidate._destroy = original;
                else delete (candidate as Partial<Readable>)._destroy;
            };
        }
        if (typeof candidate.end !== 'function') throw new TypeError('WGA_SDK_QUERY_SOURCE');
        if (stream.destroyed) { stopSource(); return stream; }
        source.pause();
        source.on('data', onData); source.on('end', onEnd);
        source.on('info', onInfo); source.on('metadata', onMetadata); source.on('status', onStatus);
        if (source.readableEnded) onEnd();
        else if (source.destroyed) stream.destroy(source.errored ?? new Error('WGA_SDK_STREAM_CLOSED'));
        else if (reading) source.resume();
    } catch (error) { stream.destroy(error instanceof Error ? error : new Error('WGA_SDK_QUERY_START')); }
    return stream;
}
