import { status, TransportError, WorkersGrpcConfigurationError as ConfigError } from './status';

/** Optional limits shared by calls using one transport configuration snapshot. */
export interface ResourceLimits {
    maxConcurrentCalls?: number;
    maxQueuedCalls?: number;
    maxBufferedBytes?: number;
    readableHighWaterMark?: number;
}
export interface ResourceDiagnostics {
    activeCalls: number;
    queuedCalls: number;
    bufferedBytes: number;
    peakActiveCalls: number;
    peakQueuedCalls: number;
    peakBufferedBytes: number;
}
export interface ByteLease {
    /** Reserve the new total size before allocating its additional bytes. */
    resize(bytes: number): void;
    release(): void;
}

/** One buffer ownership lifetime; closing it also prevents later allocations. */
export class ResourceScope {
    private closed = false;
    private readonly leases = new Set<ByteLease>();
    private readonly children = new Set<ResourceScope>();
    constructor(private readonly budget: ResourceBudget, private parent?: ResourceScope) {}
    scope(): ResourceScope {
        if (this.closed) throw new TransportError(status.CANCELLED, 'WGA_BUFFER_SCOPE_CLOSED');
        const child = new ResourceScope(this.budget, this);
        this.children.add(child);
        return child;
    }
    reserve(bytes: number): ByteLease {
        if (this.closed) throw new TransportError(status.CANCELLED, 'WGA_BUFFER_SCOPE_CLOSED');
        const lease = this.budget.reserve(bytes);
        const owned: ByteLease = {
            resize: next => {
                if (this.closed) throw new TransportError(status.CANCELLED, 'WGA_BUFFER_SCOPE_CLOSED');
                lease.resize(next);
            },
            release: () => { lease.release(); this.leases.delete(owned); },
        };
        this.leases.add(owned);
        return owned;
    }
    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const child of this.children) child.close();
        for (const lease of this.leases) lease.release();
        this.parent?.children.delete(this);
        this.parent = undefined;
    }
}

export function validateResourceLimits(input: ResourceLimits = {}): Readonly<ResourceLimits> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ConfigError('WGA_INVALID_CONFIG', 'Resource limits must be an object');
    }
    const allowed = ['maxConcurrentCalls', 'maxQueuedCalls', 'maxBufferedBytes', 'readableHighWaterMark'] as const;
    if (Object.keys(input).some(key => !(allowed as readonly string[]).includes(key))) {
        throw new ConfigError('WGA_INVALID_CONFIG', 'Unknown resource limit');
    }
    const result: ResourceLimits = {};
    for (const key of allowed) {
        const value = input[key];
        if (value === undefined) continue;
        if (!Number.isSafeInteger(value) || value < (key === 'maxQueuedCalls' ? 0 : 1)
            || (key === 'maxBufferedBytes' && value > 2147483647)) {
            throw new ConfigError('WGA_INVALID_CONFIG', `Invalid ${key}`);
        }
        result[key] = value;
    }
    if (result.maxQueuedCalls !== undefined && result.maxConcurrentCalls === undefined) {
        throw new ConfigError('WGA_INVALID_CONFIG', 'maxQueuedCalls requires maxConcurrentCalls');
    }
    return Object.freeze(result);
}

interface Admission {
    state: 'waiting' | 'active' | 'released';
    signal?: AbortSignal;
    abort: () => void;
    release: () => void;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
}
function cancelled(): TransportError {
    return new TransportError(status.CANCELLED, 'WGA_CALL_QUEUE_CANCELLED');
}
function validBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Invalid byte reservation');
}
function detach(admission: Admission): void {
    try { admission.signal?.removeEventListener('abort', admission.abort); }
    catch { /* A custom signal cannot prevent accounting and queue progress. */ }
}

/** Counts admitted logical calls and adapter-visible buffers, not platform sockets or JS heap. */
export class ResourceBudget {
    readonly limits: Readonly<ResourceLimits>;
    private active = 0;
    private buffered = 0;
    private peakActive = 0;
    private peakQueued = 0;
    private peakBuffered = 0;
    private readonly queue: Admission[] = [];
    private draining = false;

    constructor(limits?: ResourceLimits) {
        this.limits = validateResourceLimits(limits);
    }
    diagnostics(): ResourceDiagnostics {
        return { activeCalls: this.active, queuedCalls: this.queue.length, bufferedBytes: this.buffered,
            peakActiveCalls: this.peakActive, peakQueuedCalls: this.peakQueued, peakBufferedBytes: this.peakBuffered };
    }
    /** Abort releases admission only; independent buffer leases remain owned by their caller. */
    acquire(signal?: AbortSignal): Promise<() => void> {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) { reject(cancelled()); return; }
            const immediate = this.queue.length === 0 && this.active < (this.limits.maxConcurrentCalls ?? Infinity);
            if (!immediate && this.queue.length >= (this.limits.maxQueuedCalls ?? 0)) {
                reject(new TransportError(status.RESOURCE_EXHAUSTED, 'WGA_CALL_QUEUE_FULL')); return;
            }
            const admission: Admission = {
                state: immediate ? 'active' : 'waiting', signal, resolve, reject,
                abort: () => {
                    if (admission.state === 'released') return;
                    const waiting = admission.state === 'waiting';
                    admission.state = 'released';
                    if (waiting) this.queue.splice(this.queue.indexOf(admission), 1);
                    else this.active--;
                    detach(admission);
                    reject(cancelled());
                    this.drain();
                },
                release: () => {
                    if (admission.state !== 'active') return;
                    admission.state = 'released'; this.active--;
                    detach(admission);
                    this.drain();
                },
            };
            if (immediate) {
                this.active++; this.peakActive = Math.max(this.peakActive, this.active);
            } else {
                this.queue.push(admission); this.peakQueued = Math.max(this.peakQueued, this.queue.length);
            }
            try { signal?.addEventListener('abort', admission.abort, { once: true }); }
            catch { admission.abort(); }
            // A custom signal can abort/release during listener registration.
            if (signal?.aborted) admission.abort();
            if (admission.state === 'released') detach(admission);
            else if (admission.state === 'active') resolve(admission.release);
        });
    }
    private drain(): void {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.queue.length > 0 && this.active < (this.limits.maxConcurrentCalls ?? Infinity)) {
                const admission = this.queue[0];
                if (admission.signal?.aborted) { admission.abort(); continue; }
                this.queue.shift(); admission.state = 'active'; this.active++;
                this.peakActive = Math.max(this.peakActive, this.active);
                admission.resolve(admission.release);
            }
        } finally { this.draining = false; }
    }
    scope(): ResourceScope { return new ResourceScope(this); }
    reserve(bytes: number): ByteLease {
        validBytes(bytes);
        let current = 0, released = false;
        const lease: ByteLease = {
            resize: next => {
                validBytes(next);
                if (released) throw new TransportError(status.INTERNAL, 'WGA_BUFFER_RELEASED');
                const total = this.buffered - current + next;
                if (!Number.isSafeInteger(total) || total > (this.limits.maxBufferedBytes ?? Number.MAX_SAFE_INTEGER)) {
                    throw new TransportError(status.RESOURCE_EXHAUSTED, 'WGA_BUFFER_BUDGET');
                }
                this.buffered = total; current = next;
                this.peakBuffered = Math.max(this.peakBuffered, total);
            },
            release: () => {
                if (released) return;
                released = true; this.buffered -= current; current = 0;
            },
        };
        lease.resize(bytes);
        return lease;
    }
}
